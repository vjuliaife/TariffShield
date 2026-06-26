import fs from "fs";
import path from "path";
import { globSync } from "glob"; // we might not have glob installed, but we can use fs.readdirSync recursively or just hardcode apps/*
// Wait, the issue says: `discovers all .env.example files under apps/ automatically (no hardcoded paths) using a glob pattern`

import { parse } from "dotenv";

function findEnvExamples(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory() && file !== "node_modules") {
      results = results.concat(findEnvExamples(filePath));
    } else if (file === ".env.example") {
      results.push(filePath);
    }
  }
  return results;
}

const appsDir = path.join(process.cwd(), "apps");
let exampleFiles: string[] = [];
try {
  exampleFiles = findEnvExamples(appsDir);
} catch (e) {
  console.log("No apps/ directory found or error reading.");
}

let createdCount = 0;
let mergedCount = 0;
const needsConfiguration: { file: string; key: string }[] = [];

for (const exampleFile of exampleFiles) {
  const dir = path.dirname(exampleFile);
  const isWeb = dir.endsWith("web");
  const envFileName = isWeb ? ".env.local" : ".env";
  const targetFile = path.join(dir, envFileName);
  
  const exampleContent = fs.readFileSync(exampleFile, "utf-8");
  const parsedExample = parse(exampleContent);
  
  let targetParsed: Record<string, string> = {};
  let isCreated = false;
  
  if (fs.existsSync(targetFile)) {
    targetParsed = parse(fs.readFileSync(targetFile, "utf-8"));
  } else {
    isCreated = true;
  }
  
  let newContent = isCreated ? "" : fs.readFileSync(targetFile, "utf-8");
  if (newContent && !newContent.endsWith("\n")) newContent += "\n";
  
  let addedAny = false;
  
  for (const [key, value] of Object.entries(parsedExample)) {
    if (!(key in targetParsed)) {
      newContent += `${key}=${value}\n`;
      targetParsed[key] = value;
      addedAny = true;
    }
    
    // Check if it needs configuration
    const finalValue = targetParsed[key];
    if (
      !finalValue ||
      finalValue.includes("YOUR_VALUE_HERE") ||
      finalValue.includes("changeme") ||
      finalValue.includes("replace-with") ||
      finalValue === ""
    ) {
      needsConfiguration.push({ file: targetFile, key });
    }
  }
  
  if (isCreated) {
    fs.writeFileSync(targetFile, newContent);
    createdCount++;
    console.log(`Created: ${targetFile}`);
  } else if (addedAny) {
    fs.writeFileSync(targetFile, newContent);
    mergedCount++;
    console.log(`Merged missing keys into: ${targetFile}`);
  }
}

if (createdCount === 0 && mergedCount === 0) {
  console.log("Nothing to do. All .env files are up to date.");
} else {
  console.log(`\nSummary: Created ${createdCount} files, Merged ${mergedCount} files.`);
}

if (needsConfiguration.length > 0) {
  console.log("\n⚠️ The following variables still need manual configuration:");
  for (const item of needsConfiguration) {
    console.log(`  - ${item.file}: ${item.key}`);
  }
}

// Check .gitignore
const gitignorePath = path.join(process.cwd(), ".gitignore");
if (fs.existsSync(gitignorePath)) {
  const gitignore = fs.readFileSync(gitignorePath, "utf-8");
  if (!gitignore.includes(".env")) {
    console.warn("⚠️ Warning: .env is not in .gitignore!");
  }
} else {
  console.warn("⚠️ Warning: .gitignore not found!");
}
