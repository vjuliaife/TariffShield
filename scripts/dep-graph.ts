#!/usr/bin/env tsx
/**
 * scripts/dep-graph.ts
 *
 * Generates a dependency graph visualization of all npm workspace packages
 * by analyzing package.json files and resolving internal workspace dependencies.
 *
 * Usage:
 *   npm run dep-graph                        # Outputs Mermaid format (default)
 *   npm run dep-graph -- --format dot        # Outputs DOT format
 *   npm run dep-graph -- --format dot | dot -Tsvg -o docs/dep-graph.svg
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface PackageInfo {
  name: string;
  path: string;
  dependencies: string[];
  devDependencies: string[];
}

function findWorkspacePackages(rootDir: string): PackageInfo[] {
  const rootPackageJsonPath = path.join(rootDir, "package.json");
  const rootPackageJson = JSON.parse(
    fs.readFileSync(rootPackageJsonPath, "utf-8"),
  );
  const workspaces: string[] = rootPackageJson.workspaces || [];

  const packages: PackageInfo[] = [];

  for (const workspace of workspaces) {
    // Handle glob patterns like "packages/*" and "apps/*"
    const workspacePath = workspace.replace("/*", "");
    const workspaceDir = path.join(rootDir, workspacePath);

    if (!fs.existsSync(workspaceDir)) {
      continue;
    }

    const subdirs = fs.readdirSync(workspaceDir);
    for (const subdir of subdirs) {
      const packageDir = path.join(workspaceDir, subdir);
      const packageJsonPath = path.join(packageDir, "package.json");

      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const dependencies = Object.keys(packageJson.dependencies || {});
      const devDependencies = Object.keys(packageJson.devDependencies || {});

      packages.push({
        name: packageJson.name,
        path: path.relative(rootDir, packageDir),
        dependencies,
        devDependencies,
      });
    }
  }

  return packages;
}

function filterWorkspaceDependencies(
  packages: PackageInfo[],
): Map<string, string[]> {
  const packageNames = new Set(packages.map((p) => p.name));
  const graph = new Map<string, string[]>();

  for (const pkg of packages) {
    const workspaceDeps = [
      ...pkg.dependencies.filter((dep) => packageNames.has(dep)),
      ...pkg.devDependencies.filter((dep) => packageNames.has(dep)),
    ];
    graph.set(pkg.name, workspaceDeps);
  }

  return graph;
}

function detectCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (recursionStack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      dfs(neighbor);
    }

    path.pop();
    recursionStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

function generateDot(graph: Map<string, string[]>): string {
  let output = "digraph TariffShieldDependencies {\n";
  output += "  rankdir=LR;\n";
  output += "  node [shape=box, style=rounded];\n\n";

  for (const [pkg, deps] of graph.entries()) {
    const nodeLabel = pkg.replace("@tariffshield/", "");
    for (const dep of deps) {
      const depLabel = dep.replace("@tariffshield/", "");
      output += `  "${nodeLabel}" -> "${depLabel}";\n`;
    }
  }

  output += "}\n";
  return output;
}

function generateMermaid(graph: Map<string, string[]>): string {
  let output = "```mermaid\ngraph LR\n";

  for (const [pkg, deps] of graph.entries()) {
    const nodeLabel = pkg.replace("@tariffshield/", "");
    for (const dep of deps) {
      const depLabel = dep.replace("@tariffshield/", "");
      output += `  ${sanitizeMermaidId(nodeLabel)}[${nodeLabel}] --> ${sanitizeMermaidId(depLabel)}[${depLabel}]\n`;
    }
  }

  output += "```\n";
  return output;
}

function sanitizeMermaidId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function main() {
  const args = process.argv.slice(2);
  const formatIndex = args.indexOf("--format");
  const format =
    formatIndex >= 0 && args[formatIndex + 1]
      ? args[formatIndex + 1]
      : "mermaid";

  const rootDir = process.cwd();
  const packages = findWorkspacePackages(rootDir);

  if (packages.length === 0) {
    console.error("ERROR: No workspace packages found");
    process.exit(1);
  }

  const graph = filterWorkspaceDependencies(packages);
  const cycles = detectCycles(graph);

  if (cycles.length > 0) {
    console.error("ERROR: Circular dependencies detected:");
    for (const cycle of cycles) {
      console.error(`  ${cycle.join(" -> ")}`);
    }
    process.exit(1);
  }

  if (format === "dot") {
    console.log(generateDot(graph));
  } else if (format === "mermaid") {
    console.log(generateMermaid(graph));
  } else {
    console.error(`ERROR: Unknown format "${format}". Use "dot" or "mermaid".`);
    process.exit(1);
  }
}

main();
