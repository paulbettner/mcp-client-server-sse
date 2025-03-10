# MCP Client Server SSE Repository Guide

## Build & Test Commands
- Build: `yarn build` or `npm run build`
- Start: `yarn start` or `npm run start`
- Development: `yarn dev` or `npm run dev`
- Run tests: `yarn test` or `npm run test`
- Run specific test: `LOG_LEVEL=DEBUG ts-node --esm src/test-runner.ts <test-suite-name>`
- Register SSE server: Use menu option 2 in the CLI or call `registerSSEServer('name', 'url')`

## Code Style Guidelines
- **TypeScript**: Use strict typing with proper interfaces/types
- **Imports**: Use ES modules (import/export) with .js extension for local imports
- **Error Handling**: Extend base MCPTestError class for domain-specific errors
- **Naming**: 
  - camelCase for variables and functions
  - PascalCase for classes and types
  - ALL_CAPS for constants
- **Logging**: Use Logger class with appropriate log levels
- **Structure**: Organize code in modules under src/ directory
- **Async**: Use async/await pattern for asynchronous operations