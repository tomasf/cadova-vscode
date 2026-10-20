import { readFileSync } from "node:fs";
import { SwiftModelScanner } from "../src/SwiftModelScanner";
for (const file of process.argv.slice(2)) {
    const text = readFileSync(file, "utf8");
    for (const d of SwiftModelScanner.scan(text)) {
        const line = text.slice(0, d.offset).split("\n").length;
        console.log(`${file.split("/").slice(-2).join("/")}:${line} ${d.kind} ${d.filterName ?? ""}`);
    }
}
