# MCP Client Server Guide

## Overview
This package provides a client for testing and integrating with Model Context Protocol (MCP) servers. It supports both stdio and SSE (Server-Sent Events) communication methods, with thorough implementation of the MCP protocol specification.

## What is the Model Context Protocol (MCP)?

MCP is a standardized protocol that allows LLMs (Large Language Models) to interact with external servers to:
- Call tools (functions)
- Access resources (file-like data)
- Use predefined prompts

The protocol follows a JSON-RPC 2.0 message format and supports various transport methods, including stdio and SSE.

## Build & Test Commands
- Build: `npm run build` - Compiles TypeScript to JavaScript
- Start: `npm run start` - Starts the client server
- Development: `npm run dev` - Runs in development mode with TypeScript
- Register SSE server: `mcp__mcp-test__mcp_test_register_sse_server --name="server-name" --url="http://localhost:PORT" --force=true`

## Key Features
- SSE (Server-Sent Events) support for real-time communication
- Custom transport layer for the MCP protocol
- Test framework for validating MCP servers
- Docker integration for managing server instances

## Code Structure
- `src/operations/` - Core operation modules including MCP client and Docker management
- `src/common/` - Shared utilities, logging, and error handling
- `src/types/` - TypeScript type definitions and schema validation

## MCP Test Tools

The MCP test tools provide a comprehensive way to test MCP servers:

```bash
# Deploy a server for testing
mcp__mcp-test__mcp_test_deploy_server --name="server-name" --source_path="/path/to/server" --env_vars='{"ENV_VAR":"value"}'  

# For SSE servers, register server
mcp__mcp-test__mcp_test_register_sse_server --name="server-name" --url="http://localhost:3334" --force=true

# Call a tool on the server
mcp__mcp-test__mcp_test_call_tool --server_name="server-name" --tool_name="tool-name" --arguments='{"param":"value"}'  

# Get server logs
mcp__mcp-test__mcp_test_get_logs --server_name="server-name" --lines=100

# List deployed servers
mcp__mcp-test__mcp_test_list_servers

# Stop a server
mcp__mcp-test__mcp_test_stop_server --server_name="server-name"  

# Unregister SSE server
mcp__mcp-test__mcp_test_unregister_sse_server --name="server-name"
```

## Understanding the MCP Protocol

### MCP Communication Flow

1. **Connection Establishment**:
   - For stdio: Connection is established via stdin/stdout pipes
   - For SSE (Server-Sent Events):
     - Client connects to server via GET request to an endpoint (typically "/")
     - Server responds with SSE headers and begins streaming events
     - Server sends an "endpoint" event with URL where client should POST messages
     - This URL includes a query parameter for session ID: `/?sessionId=xyz123`

2. **Initialization**:
   - Client sends an `initialize` method with protocol version and capabilities
   - Server responds with its capabilities and supported features

3. **Tool Discovery**:
   - Client can request a list of available tools via `tools/list`
   - Server responds with tool names, descriptions, and parameter schemas

4. **Tool Invocation**:
   - Client sends a `tools/call` method with tool name and arguments
   - Server validates arguments (typically using Zod schemas)
   - Server executes the tool and returns the result
   - Results contain structured content (text, images, etc.)

5. **Error Handling**:
   - All errors follow the JSON-RPC 2.0 error format
   - Client can implement reconnection logic for dropped connections

### The MCP Session Lifecycle

When working with SSE-based MCP servers, understanding the session lifecycle is crucial:

1. **Session Creation**:
   - When a client makes a GET request, the server:
     - Creates a new SSEServerTransport instance
     - Generates a unique session ID (accessible via `transport.sessionId`)
     - Sends an "endpoint" event with this session ID
     - Stores the transport mapped to this session ID

2. **Client Communication**:
   - Client receives the endpoint URL with the session ID
   - All subsequent POST requests include this session ID as a query parameter
   - Server uses this ID to look up the corresponding transport

3. **Session Termination**:
   - When the connection closes (client disconnects or server stops)
   - Server detects the close event and removes the transport from its map
   - Any resources associated with the session are cleaned up

## SSE Implementation Details

The SSE implementation in the MCP protocol has several important characteristics:

1. **Client-side SSE Transport**:
   - Uses the browser's native EventSource API or a polyfill
   - Connects to the server via GET request
   - Listens for specific event types: "message", "endpoint", etc.
   - Sends JSON-RPC requests via POST to the endpoint URL

2. **Server-side SSE Transport**:
   - Extends Express or similar HTTP framework
   - GET endpoint for establishing SSE connections
   - POST endpoint for receiving client messages
   - Maps session IDs to transport instances
   - Uses the official MCP SDK's `SSEServerTransport` class

3. **SSE Connection Flow**:
   - Client -> Server: GET request to establish SSE connection
   - Server -> Client: SSE headers and "endpoint" event
   - Client -> Server: POST requests to endpoint with session ID
   - Server -> Client: SSE events with JSON-RPC responses

## Debugging SSE-based MCP Servers

### Common Issues and Solutions

#### Connection Problems

1. **Client can't connect to server**
   - **Issue**: GET request fails or connection drops immediately
   - **Check**: Is server running? Correct port? No CORS issues?
   - **Solution**: Use `curl -N http://localhost:PORT` to test direct connection

2. **404 Not Found errors**
   - **Issue**: POST requests can't find the right endpoint
   - **Check**: Is the endpoint URL correct? Does it include session ID?
   - **Solution**: Check server logs for the actual endpoint path

#### Session ID Issues

1. **Transport not found errors**
   - **Issue**: Server can't find a transport for the session ID
   - **Check**: Are session IDs being properly tracked?
   - **Solution**: Log session IDs on both client and server

2. **Multiple clients confusion**
   - **Issue**: Sessions getting mixed up or overwritten
   - **Check**: How are transports stored? Map implementation?
   - **Solution**: Use a proper session ID storage mechanism

#### Message Processing Problems

1. **Messages not being processed**
   - **Issue**: Client sends messages but server doesn't respond
   - **Check**: Is `handlePostMessage` being called correctly?
   - **Solution**: Add verbose logging for request bodies and processing

2. **Tool invocation errors**
   - **Issue**: Tool call fails with validation or execution errors
   - **Check**: Correct arguments? Tool implementation sound?
   - **Solution**: Test tools directly with the test client

### Complete SSE Debugging Workflow

When troubleshooting SSE-based MCP servers:

1. **Deploy with Environment Variables**:
   ```bash
   mcp__mcp-test__mcp_test_deploy_server --name="sse-server" --source_path="/path/to/server" --env_vars='{"MCP_TRANSPORT_TYPE":"sse","MCP_PORT":"3334"}'
   ```

2. **Force New Registration**:
   ```bash
   mcp__mcp-test__mcp_test_unregister_sse_server --name="sse-server"
   mcp__mcp-test__mcp_test_register_sse_server --name="sse-server" --url="http://localhost:3334" --force=true
   ```

3. **Check for Server Listening**:
   ```bash
   lsof -i :3334
   curl -N http://localhost:3334  # Should maintain an open connection
   ```

4. **Examine Detailed Logs**:
   ```bash
   mcp__mcp-test__mcp_test_get_logs --server_name="sse-server" --lines=100
   ```

5. **Test Simple Tools First**:
   - Start with an "echo" tool that just returns the input
   - Then progress to more complex tools
   ```bash
   mcp__mcp-test__mcp_test_call_tool --server_name="sse-server" --tool_name="echo" --arguments='{"message":"test"}'
   ```

6. **Inspect Network Communication**:
   - Use browser DevTools Network tab (for web clients)
   - Or use a proxy like mitmproxy to see request/response details

7. **Try Single-Client Mode**:
   - For debugging, simplify to a single active transport
   - Add fallback logic for missing session IDs (in development only)

## Server Reset Procedure

If you need to completely reset the environment:

1. **Stop All MCP Servers**:
   ```bash
   mcp__mcp-test__mcp_test_list_servers | jq -r '.servers[].name' | xargs -I {} mcp__mcp-test__mcp_test_stop_server --server_name="{}"
   ```

2. **Kill the Client Server Process**:
   ```bash
   pkill -f "node.*mcp-client-server/dist"
   ```

3. **Restart Client Server**:
   ```bash
   cd /Users/paulbettner/Projects/smarty-pants
   node packages/mcp-client-server/dist/index.js > mcp-client.log 2>&1 &
   ```

4. **Check for Orphaned Processes**:
   ```bash
   lsof -i :3334  # Check if anything is still using your port
   ```

## JSON-RPC Message Reference

All MCP protocol communication uses JSON-RPC 2.0 format:

```javascript
// Initialize request
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "client-name",
      "version": "1.0.0"
    }
  },
  "id": 0
}

// Tool call request
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "tool-name",
    "arguments": {
      "param1": "value1",
      "param2": 42
    }
  },
  "id": 1
}

// Successful response
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      { 
        "type": "text", 
        "text": "Result content here" 
      }
    ]
  },
  "id": 1
}

// Error response
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32602,
    "message": "Invalid params: Parameter validation failed"
  },
  "id": 1
}
```

## Testing with the Simple SSE Server

We've created a minimal reference implementation in `packages/mcp-servers/development/simple-sse-server` that demonstrates proper MCP over SSE. To use it for testing:

```bash
# Deploy the server
mcp__mcp-test__mcp_test_deploy_server --name="simple-sse" --source_path="/Users/paulbettner/Projects/smarty-pants/packages/mcp-servers/development/simple-sse-server" --env_vars='{"MCP_TRANSPORT_TYPE":"sse","MCP_PORT":"3335"}'

# Register with the client
mcp__mcp-test__mcp_test_register_sse_server --name="simple-sse" --url="http://localhost:3335" --force=true

# Test the echo tool
mcp__mcp-test__mcp_test_call_tool --server_name="simple-sse" --tool_name="echo" --arguments='{"message":"Hello, MCP!"}'

# Test the add tool
mcp__mcp-test__mcp_test_call_tool --server_name="simple-sse" --tool_name="add" --arguments='{"a":5,"b":7}'
```

## Best Practices

1. **Force Registration**: Always use the `--force=true` flag when registering SSE servers during development
2. **Verbose Logging**: Add detailed logging on both client and server sides
3. **Port Management**: Be aware of port conflicts and use environment variables to configure ports
4. **Simple-to-Complex**: Start with simple tools like "echo" before implementing complex ones
5. **Session Tracking**: Implement proper session ID tracking and cleanup
6. **Error Handling**: Follow JSON-RPC error format for all error responses
7. **Testing**: Use MCP test tools to validate your server implementation
8. **SDK Compatibility**: Use the official MCP SDK classes (`McpServer`, `SSEServerTransport`, etc.)
9. **Protocol Compliance**: Follow the MCP specification for all message formats and events
10. **Documentation**: Maintain clear documentation of your server's tools and capabilities
