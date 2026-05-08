import express from "express";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {mcpAuthMetadataRouter} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {requireBearerAuth} from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {createRemoteJWKSet, jwtVerify} from "jose";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {AuthInfo} from "@modelcontextprotocol/sdk/server/auth/types.js";

// --- OAuth config ---
const ISSUER = process.env.ISSUER ?? "https://openam-sdks.forgeblocks.com:443/am/oauth2/alpha";
//const ISSUER = process.env.ISSUER ?? "https://openam-sdks.forgeblocks.com:443/am/oauth2";
const JWKS_URI = `${ISSUER}/connect/jwk_uri`;
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";

// --- Stateless JWT verifier using ForgeRock JWKS ---
const jwks = createRemoteJWKSet(new URL(JWKS_URI));

const tokenVerifier = {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
        const {payload} = await jwtVerify(token, jwks, {
            issuer: ISSUER,
        });

        const scopes =
            typeof payload.scope === "string" ? payload.scope.split(" ") : [];
        const clientId =
            typeof payload.client_id === "string"
                ? payload.client_id
                : typeof payload.azp === "string"
                    ? payload.azp
                    : "";

        return {
            token,
            clientId,
            scopes,
            ...(typeof payload.exp === "number" ? {expiresAt: payload.exp} : {}),
        };
    },
};

// --- Tool logic ---
function calculateTax(price: number, taxRate: number = 0.15): number {
    const total = price * (1 + taxRate);
    return Number.parseFloat(total.toFixed(2));
}

// --- Factory: one McpServer + transport pair per session ---
function createSessionServer(authInfo?: AuthInfo) {
    const server = new McpServer({
        name: "aic-mcp-server2",
        version: "1.0.0",
    });

    server.tool(
        "calculateTax",
        "Calculate the total price after applying a tax rate",
        {
            price: z.number().positive().describe("The base price before tax"),
            taxRate: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe("Tax rate as a decimal (default 0.15 = 15%)"),
        },
        async ({price, taxRate}) => {
            const total = calculateTax(price, taxRate);
            return {
                content: [{type: "text", text: `Total price (including tax): ${total}`}],
            };
        }
    );

    server.tool(
        "inspectAccessToken",
        "Inspect the details of the access token used for authentication",
        {},
        async () => {
            if (!authInfo) {
                return {content: [{type: "text", text: "No authentication info available."}]};
            }

            const payloadB64 = authInfo.token.split(".")[1];
            let claims: Record<string, unknown> = {};
            try {
                if (payloadB64) {
                    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
                }
            } catch {
                // non-JWT token; proceed with AuthInfo fields only
            }

            const expiresAt = authInfo.expiresAt
                ? new Date(authInfo.expiresAt * 1000).toISOString()
                : undefined;

            const detail = {
                clientId: authInfo.clientId,
                scopes: authInfo.scopes,
                ...(expiresAt ? {expiresAt} : {}),
                claims,
            };

            return {
                content: [{type: "text", text: JSON.stringify(detail, null, 2)}],
            };
        }
    );

    return server;
}

// --- Session store ---
const sessions = new Map<string, StreamableHTTPServerTransport>();

// --- Express app ---
const app = express();
app.use(express.json());

// Advertise OAuth metadata (AS = ForgeRock, RS = this server)
app.use(
    mcpAuthMetadataRouter({
        oauthMetadata: {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/access_token`,
            jwks_uri: JWKS_URI,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
            revocation_endpoint: `${ISSUER}/token/revoke`,
            registration_endpoint: `${ISSUER}/register`,
            scopes_supported: ["openid", "profile", "email"],
        },
        resourceServerUrl: new URL(`${SERVER_URL}/mcp`),
        scopesSupported: ["openid", "profile", "email"],
        resourceName: "aic-mcp-server2",
    })
);

// Bearer auth middleware — validates JWT locally, no network call needed
const bearerAuth = requireBearerAuth({
    verifier: tokenVerifier,
    resourceMetadataUrl: `${SERVER_URL}/.well-known/oauth-protected-resource/mcp`,
});

app.all("/mcp", bearerAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
    }

    const isInit = req.method === "POST" && req.body?.method === "initialize";
    if (!isInit) {
        res.status(400).json({error: "No valid session. Send initialize first."});
        return;
    }

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createSessionServer((req as { auth?: AuthInfo }).auth);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
    }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
    console.log(`MCP HTTP server listening on http://localhost:${PORT}/mcp`);
    console.log(`OAuth issuer: ${ISSUER}`);
});
