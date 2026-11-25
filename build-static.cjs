const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const output = path.join(root, "dist");

const files = [
    "index.html",
    "style.css",
    "script.js",
    "payment.css",
    "payment.js",
    "payment-ui.js",
    "payment-return.js"
];

for (const file of files) {
    if (!fs.statSync(path.join(root, file)).isFile()) {
        throw new Error(`Invalid frontend file: ${file}`);
    }
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of files) {
    fs.copyFileSync(
        path.join(root, file),
        path.join(output, file)
    );

    console.log(`[OK] ${file}`);
}

console.log("Secure static build completed.");
console.log(`Public files: ${files.length}`);
