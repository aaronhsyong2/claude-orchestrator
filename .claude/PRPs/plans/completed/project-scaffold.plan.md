# Plan: Project Scaffold — pnpm + tsup + Biome + vitest + Ink + ESM

## Summary

Initialize the claude-orchestrator repo as a TypeScript CLI project. Set up pnpm workspace, tsup for CLI bundling, Biome for linting/formatting, vitest for testing, and Ink as the TUI framework. Configure ESM module system targeting ES2022. Include a minimal "hello world" Ink render to verify the TUI framework works.

## User Story

As a developer, I want a fully scaffolded TypeScript CLI project so that subsequent PRs can build features on a proven foundation.

## Problem -> Solution

Empty repo with only docs -> Fully scaffolded TypeScript CLI with build, lint, test, dev scripts and a working Ink render.

## Metadata

- **Complexity**: Medium
- **Source PRD**: `docs/guide/claude-orchestrator-prd-v2.md`
- **PRD Phase**: PR 1 / Issue #2
- **Estimated Files**: 8 new files

---

## UX Design

N/A — internal tooling setup, no user-facing UX change.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `docs/decisions/001-design-decisions.md` | 94-100 (decision #17) | Tooling decisions: pnpm, tsup, Biome, vitest, ES2022, ESM, Ink |
| P1 | `docs/guide/claude-orchestrator-prd-v2.md` | 227-235 | Tooling section confirming all choices |
| P2 | `docs/guide/claude-orchestrator-pr-plan.md` | 22-29 | PR 1 scope: issues #2 and #3 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Ink 7.x | npm/github | Requires React >=19, ESM, Node >=18.13. Uses `react-jsx` transform |
| tsup CLI | tsup.egoist.dev | Auto-handles hashbang from source, ESM output, `shims: true` for compatibility |
| Biome 2.x | biomejs.dev | Schema at `https://biomejs.dev/schemas/2.0.0/schema.json`, auto-detects TSX |
| vitest 3.x | vitest.dev | ESM-native, `environment: 'node'` for non-component tests |

---

## Patterns to Mirror

### NAMING_CONVENTION

New project — establishing conventions per ADR 001:
- Files: kebab-case (`verification-pipeline.ts`)
- Exports: PascalCase for types/components, camelCase for functions
- CLI binary name: `orchestrator`

### ERROR_HANDLING

Not applicable for scaffold — no business logic yet.

### TEST_STRUCTURE

Establishing convention:
- Test files colocated: `src/**/*.test.ts`
- vitest globals enabled
- Coverage via v8 provider

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `package.json` | CREATE | Project manifest with deps, scripts, bin entry |
| `tsconfig.json` | CREATE | TypeScript config: ES2022, ESM, strict, react-jsx |
| `tsup.config.ts` | CREATE | CLI bundling config |
| `biome.json` | CREATE | Linting and formatting rules |
| `vitest.config.ts` | CREATE | Test framework config |
| `.gitignore` | CREATE | Ignore node_modules, dist, .orchestrator/* (except config.json) |
| `src/cli.tsx` | CREATE | CLI entry point with hashbang + minimal Ink render |
| `src/cli.test.ts` | CREATE | Placeholder test to verify vitest works |

## NOT Building

- CLI subcommand logic (that's #3)
- Any orchestrator business logic
- `.orchestrator/config.json` content or structure
- Complex Ink components or layout
- CI/CD pipeline

---

## Step-by-Step Tasks

### Task 1: Create package.json

- **ACTION**: Create `package.json` with all dependencies, scripts, and bin entry
- **IMPLEMENT**:
  ```json
  {
    "name": "claude-orchestrator",
    "version": "0.1.0",
    "description": "Autonomous agent TUI dashboard for Claude Code",
    "type": "module",
    "bin": {
      "orchestrator": "./dist/cli.js"
    },
    "exports": "./dist/cli.js",
    "files": ["dist"],
    "scripts": {
      "build": "tsup",
      "dev": "tsx src/cli.tsx",
      "check": "biome check src",
      "test": "vitest run",
      "typecheck": "tsc --noEmit"
    },
    "dependencies": {
      "ink": "^7.0.0",
      "react": "^19.0.0"
    },
    "devDependencies": {
      "@biomejs/biome": "^2.0.0",
      "@types/react": "^19.0.0",
      "tsup": "^8.0.0",
      "tsx": "^4.0.0",
      "typescript": "^5.7.0",
      "vitest": "^3.0.0"
    },
    "engines": {
      "node": ">=20.0.0"
    }
  }
  ```
- **GOTCHA**: `"type": "module"` is required for Ink 5+/7. Without it, ESM imports fail at runtime.
- **GOTCHA**: `tsx` is for dev mode — it runs TypeScript directly without building. tsup is for production builds.
- **VALIDATE**: File exists and is valid JSON

### Task 2: Create tsconfig.json

- **ACTION**: Create TypeScript configuration targeting ES2022 with strict mode and React JSX
- **IMPLEMENT**:
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2022"],
      "module": "ESNext",
      "moduleResolution": "bundler",
      "resolveJsonModule": true,
      "strict": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "noImplicitReturns": true,
      "noFallthroughCasesInSwitch": true,
      "jsx": "react-jsx",
      "jsxImportSource": "react",
      "isolatedModules": true,
      "forceConsistentCasingInFileNames": true,
      "sourceMap": true,
      "outDir": "./dist",
      "rootDir": "./src",
      "types": ["vitest/globals", "node"]
    },
    "include": ["src"],
    "exclude": ["node_modules", "dist"]
  }
  ```
- **GOTCHA**: `"jsx": "react-jsx"` enables automatic JSX transform — no `import React` needed in .tsx files. Required for Ink.
- **GOTCHA**: `"moduleResolution": "bundler"` is correct for tsup-bundled ESM. Not `"node"` or `"node16"`.
- **VALIDATE**: `pnpm run typecheck` passes

### Task 3: Create tsup.config.ts

- **ACTION**: Create tsup config for CLI bundling with ESM output
- **IMPLEMENT**:
  ```typescript
  import { defineConfig } from 'tsup';

  export default defineConfig({
    entry: { cli: 'src/cli.tsx' },
    format: ['esm'],
    target: 'es2022',
    shims: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: false,
    minify: false,
    outDir: 'dist',
  });
  ```
- **GOTCHA**: Entry is `.tsx` not `.ts` because the CLI file renders JSX (Ink components). tsup handles TSX natively.
- **GOTCHA**: `shims: true` injects `import.meta.url` polyfill for ESM compatibility.
- **VALIDATE**: `pnpm run build` produces `dist/cli.js`

### Task 4: Create biome.json

- **ACTION**: Create Biome config for linting and formatting
- **IMPLEMENT**:
  ```json
  {
    "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
    "files": {
      "ignore": ["node_modules", "dist"]
    },
    "formatter": {
      "enabled": true,
      "indentStyle": "tab",
      "lineWidth": 100
    },
    "linter": {
      "enabled": true,
      "rules": {
        "recommended": true
      }
    },
    "javascript": {
      "formatter": {
        "quoteStyle": "single",
        "semicolons": "always",
        "trailingCommas": "all"
      }
    }
  }
  ```
- **GOTCHA**: Biome auto-detects `.tsx` files for JSX rules — no explicit JSX config needed.
- **VALIDATE**: `pnpm run check` passes with zero errors

### Task 5: Create vitest.config.ts

- **ACTION**: Create vitest config for TypeScript ESM testing
- **IMPLEMENT**:
  ```typescript
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      globals: true,
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  });
  ```
- **GOTCHA**: Use `environment: 'node'` for now. Switch to `jsdom` only when testing Ink components directly (future PRs).
- **VALIDATE**: `pnpm run test` runs successfully

### Task 6: Create .gitignore

- **ACTION**: Create .gitignore per ADR 001
- **IMPLEMENT**:
  ```
  node_modules/
  dist/
  .orchestrator/*
  !.orchestrator/config.json
  ```
- **GOTCHA**: The `.orchestrator/*` + `!.orchestrator/config.json` pattern ensures runtime state is ignored but config is committed.
- **VALIDATE**: `git status` does not show `node_modules/` or `dist/`

### Task 7: Create src/cli.tsx

- **ACTION**: Create CLI entry point with hashbang and minimal Ink render
- **IMPLEMENT**:
  ```tsx
  #!/usr/bin/env node
  import { render, Text, Box } from 'ink';

  function App() {
    return (
      <Box padding={1}>
        <Text color="green" bold>orchestrator</Text>
      </Box>
    );
  }

  render(<App />);
  ```
- **GOTCHA**: Hashbang must be first line — tsup preserves it in the built output and makes the file executable.
- **GOTCHA**: No `import React` needed — `"jsx": "react-jsx"` handles the transform automatically.
- **VALIDATE**: `node dist/cli.js` prints green "orchestrator" text

### Task 8: Create src/cli.test.ts

- **ACTION**: Create placeholder test to verify vitest works
- **IMPLEMENT**:
  ```typescript
  import { describe, it, expect } from 'vitest';

  describe('cli', () => {
    it('placeholder: vitest is configured correctly', () => {
      expect(true).toBe(true);
    });
  });
  ```
- **VALIDATE**: `pnpm run test` reports 1 passing test

### Task 9: Install dependencies and verify

- **ACTION**: Run `pnpm install` and verify all scripts work
- **VALIDATE**:
  1. `pnpm install` — succeeds, creates lockfile
  2. `pnpm run build` — produces `dist/cli.js`
  3. `pnpm run check` — zero Biome errors
  4. `pnpm run test` — 1 passing test
  5. `pnpm run dev` — runs CLI, prints Ink output
  6. `pnpm run typecheck` — zero type errors
  7. `node dist/cli.js` — prints green "orchestrator" text

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| vitest runs | placeholder test | 1 passing | No |

Testing is minimal for scaffold. Future PRs add real tests per module.

---

## Validation Commands

### Static Analysis
```bash
pnpm run typecheck
```
EXPECT: Zero type errors

### Lint
```bash
pnpm run check
```
EXPECT: Zero Biome errors

### Build
```bash
pnpm run build
```
EXPECT: `dist/cli.js` exists and is executable

### Unit Tests
```bash
pnpm run test
```
EXPECT: 1 passing test

### Dev Mode
```bash
pnpm run dev
```
EXPECT: Renders Ink output to terminal

### Manual Validation
- [ ] `node dist/cli.js` prints green "orchestrator" text
- [ ] `./dist/cli.js` is executable (hashbang works)
- [ ] `pnpm run dev` works via tsx

---

## Acceptance Criteria

- [ ] `pnpm install` succeeds with all dependencies (ink, react, tsup, biome, vitest)
- [ ] `pnpm run build` produces a compiled CLI binary via tsup
- [ ] `pnpm run check` runs Biome linting with zero errors
- [ ] `pnpm run test` runs vitest with a passing placeholder test
- [ ] `pnpm run dev` runs the CLI in development mode via tsx
- [ ] ESM module system configured (`"type": "module"` in package.json)
- [ ] TypeScript configured targeting ES2022 with strict mode
- [ ] `.gitignore` includes `node_modules/`, `dist/`, `.orchestrator/*`, `!.orchestrator/config.json`
- [ ] Running the built CLI prints a minimal Ink "orchestrator" output

## Completion Checklist

- [ ] All 9 acceptance criteria pass
- [ ] No hardcoded values
- [ ] ESM throughout (no CommonJS)
- [ ] Strict TypeScript
- [ ] Self-contained — no questions needed during implementation

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ink 7 / React 19 peer dep mismatch | Low | Medium | Pin exact compatible versions in package.json |
| Biome 2 schema breaking change | Low | Low | Pin major version, use stable schema URL |
| tsup hashbang not preserved | Low | Medium | Verify built output starts with `#!/usr/bin/env node` |

## Notes

- This is the foundation PR. Every subsequent PR depends on this.
- `tsx` is used for `dev` script (runs TS directly). `tsup` is for production builds.
- Biome replaces both ESLint and Prettier — single tool for lint+format.
- `pnpm run check` uses `biome check` which runs both lint and format checks.
- The `typecheck` script is separate from `check` — Biome doesn't do type checking.
