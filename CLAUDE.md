# MCP Client Server SSE Repository Guide

## Overview
This package provides an SSE-compatible client for Model Context Protocol (MCP) servers, allowing communication via Server-Sent Events. It extends the standard MCP client to support real-time event streaming between client and server.

## Build & Test Commands
- Build: `npm run build` - Compiles TypeScript to JavaScript
- Start: `npm run start` - Starts the client server
- Development: `npm run dev` - Runs in development mode with TypeScript
- Run tests: `npm run test` - Executes the test runner
- Run specific test: `LOG_LEVEL=DEBUG npm run test <test-suite-name>`
- Register SSE server: Use menu option 2 in the CLI or call `registerSSEServer('name', 'url')`

## Key Features
- SSE (Server-Sent Events) support for real-time communication
- Custom transport layer for the MCP protocol
- Test runner for validating MCP servers
- Docker integration for managing server instances

## Code Structure
- `src/operations/` - Core operation modules including MCP client and Docker management
- `src/common/` - Shared utilities, logging, and error handling
- `src/types/` - TypeScript type definitions and schema validation
- `test/` - Test suites and test case definitions

## Code Style Guidelines
- **TypeScript**: Use strict typing with proper interfaces/types
- **Module System**: ES modules with `.js` extension for local imports
- **Import Handling**:
  - For CommonJS modules, use:
    ```typescript
    import * as LibName from 'lib-name';
    const SomeExport = LibName.default || LibName;
    ```
  - For ESM modules, use standard imports with named exports where possible
- **Error Handling**: Extend base MCPTestError class for domain-specific errors
- **Naming Conventions**: 
  - camelCase for variables and functions
  - PascalCase for classes and types
  - ALL_CAPS for constants
- **Logging**: Use Logger class with appropriate log levels (DEBUG, INFO, WARN, ERROR)
- **Async Pattern**: Use async/await for asynchronous operations
- **Testing**: Each tool should have corresponding test cases

## Integration with Smarty Pants Monorepo
- This package follows the conventions of the Smarty Pants monorepo
- Uses the shared TypeScript configuration for consistency
- Leverages monorepo's dependencies where possible
- Can be built and tested via the top-level monorepo commands

## SSE Transport Implementation
The SSE transport layer implements the MCP Transport interface to:
1. Establish an EventSource connection for receiving events
2. Send messages via HTTP POST requests
3. Handle reconnection and error scenarios
4. Parse and dispatch JSON-RPC messages

## Development Notes
- Make sure to run `npm run build` after code changes and before testing
- Use environment variable `LOG_LEVEL=DEBUG` for detailed logging
- Test with a real MCP server for full integration testing

## SSE Resilience Improvements (2025-03-23)

We made several improvements to make the MCP client server more resilient when working with SSE servers, especially when those servers restart. These changes help with the development workflow where an MCP server is modified, rebuilt, and restarted.

### Changes Made:

1. **Enhanced SSE Transport**:
   - Added automatic reconnection logic with exponential backoff
   - Added proper error handling for connection failures
   - Added better logging of connection states
   - Fixed event parsing to handle special messages

2. **Improved Connection Management**:
   - Added connection health checks before using cached connections
   - Added cleanup of stale connections
   - Added proper timeouts using AbortController
   - Fixed error handling to properly close dead connections

3. **Added Server Registration Management**:
   - Enhanced `registerSSEServer` to clean up existing connections
   - Added `unregisterSSEServer` to force reconnection
   - Added a new tool `mcp_test_unregister_sse_server`
   - Added a `force` flag to the registration tool

4. **Error Recovery**:
   - Improved error detection and recovery in the client code
   - Added connection state tracking
   - Enhanced error messages with server names

### How to Use with Development Workflow:

1. **After Server Changes**:
   When you modify and restart an MCP server, you should:
   
   ```bash
   # After modifying server code and restarting it:
   npm run tool -- mcp__mcp-test__mcp_test_unregister_sse_server --name=server-name
   npm run tool -- mcp__mcp-test__mcp_test_register_sse_server --name=server-name --url=http://localhost:PORT
   ```

2. **Full Reset**:
   If the server doesn't reconnect properly, you may need to restart the MCP client server:
   
   ```bash
   # Find and kill the MCP client server
   pkill -f "node.*mcp-client-server/dist"
   
   # Restart it
   cd /Users/paulbettner/Projects/smarty-pants
   node packages/mcp-client-server/dist/index.js &
   ```

   **IMPORTANT**: When restarting the MCP client server, you must also restart your Claude Code session afterward. This is because:
   
   1. The Claude Code session is connected to the MCP client server process
   2. If you kill and restart that process, your current Claude Code session loses its connection
   3. The correct workflow is:
      - Document your current progress in CLAUDE.md
      - Kill the existing MCP client server processes (`pkill -f "node.*mcp-client-server/dist"`)
      - Exit the current Claude Code session
      - Start a new Claude Code session, which will automatically start a fresh MCP client server
      - Continue your work from where you left off

### Current Progress (2025-03-24)

We made the following changes to test the MCP client server's SSE reconnection capabilities:

1. Reviewed the latest SSE resilience improvements from 2025-03-23
2. Added a new "power" operation to the calculator server
3. Modified the calculator server to include validation for negative fractional exponents
4. Enhanced the power operation validation to handle additional edge cases:
   - Preventing raising zero to a negative power
   - Preventing raising negative numbers to non-integer powers
5. Updated the operation description to include the "power" operation
6. Built the calculator server with the updated validation logic

### Issues Encountered

We encountered several issues:
1. Multiple MCP client server instances were running simultaneously
2. The MCP client server wasn't properly connected to enable SSE connections
3. When trying to use the MCP test tools, we received "Not connected" errors
4. We terminated all running MCP client server instances to prepare for a clean restart

### Next Steps (For Fresh AI Session)

1. The MCP client server will be automatically started when a new Claude Code session begins
   ```bash
   # We've already killed the existing MCP client server processes:
   pkill -f "node.*mcp-client-server/dist"
   
   # No need to manually start the server - Claude Code will automatically
   # start the MCP client server when a new session begins
   ```

2. Deploy the calculator server:
   ```bash
   # Build and deploy the calculator server
   cd /Users/paulbettner/Projects/smarty-pants
   
   # Use the MCP test deploy tool
   npm run tool -- mcp__mcp-test__mcp_test_deploy_server --name=calculator-server --source_path="/Users/paulbettner/Projects/smarty-pants/packages/mcp-servers/deployed/calculator-server"
   ```

3. Register the server:
   ```bash
   # Register the SSE server
   npm run tool -- mcp__mcp-test__mcp_test_register_sse_server --name=calculator-server --url=http://localhost:3334 --force=true
   ```

4. Test regular operations:
   ```bash
   # Test addition
   npm run tool -- mcp__mcp-test__mcp_test_call_tool --server_name=calculator-server --tool_name=calculate --arguments='{"operation":"add","a":5,"b":3}'
   
   # Test power operation
   npm run tool -- mcp__mcp-test__mcp_test_call_tool --server_name=calculator-server --tool_name=calculate --arguments='{"operation":"power","a":2,"b":3}'
   ```

5. Make a small change to the calculator server and test reconnection:
   ```bash
   # Update the calculator server source code (e.g., modify validation logic)
   
   # Rebuild the server
   cd /Users/paulbettner/Projects/smarty-pants/packages/mcp-servers/deployed/calculator-server
   tsc
   
   # Stop and restart the deployed server
   npm run tool -- mcp__mcp-test__mcp_test_stop_server --server_name=calculator-server
   npm run tool -- mcp__mcp-test__mcp_test_deploy_server --name=calculator-server --source_path="/Users/paulbettner/Projects/smarty-pants/packages/mcp-servers/deployed/calculator-server"
   
   # Use the unregister tool to force reconnection
   npm run tool -- mcp__mcp-test__mcp_test_unregister_sse_server --name=calculator-server
   
   # Register again
   npm run tool -- mcp__mcp-test__mcp_test_register_sse_server --name=calculator-server --url=http://localhost:3334 --force=true
   
   # Test to see if the updated server is reached
   npm run tool -- mcp__mcp-test__mcp_test_call_tool --server_name=calculator-server --tool_name=calculate --arguments='{"operation":"power","a":2,"b":-1.5}'
   ```

6. Check the logs:
   ```bash
   # Get calculator server logs
   npm run tool -- mcp__mcp-test__mcp_test_get_logs --server_name=calculator-server --lines=20
   
   # Check MCP client server logs
   tail -n 30 mcp-client.log
   ```

The key test is to verify that after stopping, redeploying, unregistering, and re-registering the calculator server, the MCP client server can properly connect to the updated server and the updated validation logic takes effect, without needing to restart the MCP client server process itself.

These improvements should make the MCP test tool much more resilient to server restarts and changes, allowing for a smoother development workflow when working with MCP servers.

### Issue Discovery: Multiple MCP Client Servers (2025-03-24)

During testing of schema updates through the MCP client server, we encountered a critical issue: multiple MCP client server processes were running simultaneously, causing schema caching inconsistencies.

#### Problem Details:
1. When attempting to add a new "modulo" operation to the calculator server, the schema wasn't properly refreshed
2. Investigation revealed multiple MCP client server instances running:
   ```bash
   # Output of: ps aux | grep mcp-client-server | grep -v grep
   paulbettner 89286 0.0 0.1 428315808 74384 s002 TN 12:11AM 0:00.18 node packages/mcp-client-server/dist/index.js
   paulbettner 86368 0.0 0.1 428296096 76960 s002 TN 11:43PM 0:00.12 node packages/mcp-client-server/dist/index.js
   ```
3. Even after following all proper procedures (stop server, rebuild, redeploy, unregister, re-register), schema changes weren't recognized
4. The presence of multiple MCP client server processes may lead to inconsistent caching behavior

#### Implemented Solutions (2025-03-24):
1. Added a lock file mechanism to prevent multiple MCP client server instances:
   - Lock file is created at system temp directory `os.tmpdir()` with PID info
   - On server start, it checks for existing lock file and verifies if process is running
   - If a valid process is running, the new instance exits with clear error message
   - If a stale lock exists, it's replaced with the new process information
   - Lock file is automatically cleaned up on process exit with signal handlers

2. Enhanced the registerSSEServer function:
   - Added proper force parameter handling in accordance with schema
   - Now respects the force=false option and avoids unnecessary reconnections
   - Properly passes force parameter from the API call to the function

3. Built and tested the changes:
   - Verified the schema already included force parameter
   - Built the project successfully
   - Each run of the MCP client server successfully creates/cleans up its lock file

#### Restart Procedure
When working with MCP servers, follow this procedure if you need to restart the MCP client server:

1. Kill any running MCP client server processes:
   ```bash
   pkill -f "node.*mcp-client-server/dist"
   ```

2. Restart the server:
   ```bash
   cd /Users/paulbettner/Projects/smarty-pants/packages/mcp-client-server
   node dist/index.js > mcp-client.log 2>&1 &
   ```

3. After restarting, the server automatically checks for and cleans up any stale lock files.

#### Remaining Tasks for Future Improvement:
1. Add monitoring features to track MCP client server health
2. Implement explicit schema versioning to force cache invalidation on schema changes
3. Add more detailed logging around connection and disconnection events

#### Benefits:
- The MCP client server now prevents multiple instances from running simultaneously
- Force parameter support allows for more controlled reconnection behavior
- Proper cleanup of resources on server shutdown
- Robust PID checking prevents lock file issues with stale processes

These changes make the MCP client server more robust against the multiple instance issues that were causing schema caching problems.