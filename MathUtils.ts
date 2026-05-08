// A simple function with typed parameters and return type
function calculateTax(price: number, taxRate: number = 0.15): number {
    const total = price * (1 + taxRate);
    return parseFloat(total.toFixed(2));
}

// Your "Main" method equivalent
const amount = 200;
const result = calculateTax(amount);

console.log(`The total price for ${amount} is: ${result}`);