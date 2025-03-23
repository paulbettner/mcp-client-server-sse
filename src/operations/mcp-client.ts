import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ServerNotFoundError, ToolCallError } from '../common/errors.js';
import { Logger } from '../common/logger.js';
import { 
  CallToolInput, 
  CallToolResponse, 
  TestCase, 
  TestResult, 
  RunTestsInput,
  RunTestsResponse
} from '../types/schemas.js';
import { getServerProcess } from './docker.js';
// Import EventSource safely for both CommonJS and ESM environments
// @ts-ignore - Bypassing TypeScript checks for eventsource import issues
import * as EventSourceLib from 'eventsource';
// @ts-ignore - Ensure we get a constructor regardless of module format
const EventSourceConstructor = (EventSourceLib.default || EventSourceLib);
import fetch from 'node-fetch';

// Cache of connected clients by server name
const connectedClients = new Map<string, Client>();

// Create a custom Transport implementation for SSE communication
class SSETransport implements Transport {
  private eventSource: any = null;
  private messageQueue: JSONRPCMessage[] = [];
  private connected = false;
  private serverUrl: string;
  private serverName: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelay = 1000; // Start with 1 second
  
  constructor(serverName: string, serverUrl: string) {
    this.serverUrl = serverUrl;
    this.serverName = serverName;
    Logger.debug(`Creating SSE transport for server '${serverName}' at ${serverUrl}`);
  }
  
  async start(): Promise<void> {
    try {
      // Reset reconnection state
      this.reconnectAttempts = 0;
      
      // Create an EventSource for SSE connections
      this.eventSource = new EventSourceConstructor(this.serverUrl, {
        withCredentials: false, // Don't send cookies
        https: { rejectUnauthorized: false } // Accept self-signed certs for local development
      });
      
      Logger.debug(`Established SSE connection to ${this.serverUrl}`);
      
      // Set up event handlers
      if (this.eventSource) {
        this.eventSource.onopen = () => {
          Logger.debug(`SSE connection opened to ${this.serverName}`);
          this.connected = true;
          this.reconnectAttempts = 0; // Reset counter on successful connection
        };
      
        this.eventSource.onmessage = (event: any) => {
          try {
            Logger.debug(`Received raw SSE message from ${this.serverName}:`, event.data);
            
            // Try to parse the message
            let data: JSONRPCMessage;
            try {
              data = JSON.parse(event.data) as JSONRPCMessage;
            } catch (parseError) {
              // If parsing fails, check if this is a special message or not JSON
              if (event.data.includes('connected')) {
                Logger.debug(`Received connection confirmation from ${this.serverName}`);
                return; // This is just a connection message, not a JSONRPC message
              } else {
                // Re-throw the error for general error handling
                throw parseError;
              }
            }
            
            Logger.debug(`Parsed SSE message from ${this.serverName}:`, data);
            
            if (this.onmessage) {
              this.onmessage(data);
            }
          } catch (error) {
            Logger.error(`Error processing SSE message from ${this.serverName}:`, error);
            if (this.onerror && error instanceof Error) {
              this.onerror(error);
            }
          }
        };
      
        this.eventSource.onerror = async (error: any) => {
          Logger.error(`SSE connection error with ${this.serverName}:`, error);
          
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            // Try to reconnect
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff
            
            Logger.debug(`Attempting to reconnect to ${this.serverName} in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            
            // Close the current connection
            if (this.eventSource) {
              this.eventSource.close();
              this.eventSource = null;
            }
            
            // Wait before reconnecting
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Try to reconnect
            try {
              await this.start();
              Logger.debug(`Successfully reconnected to ${this.serverName}`);
            } catch (reconnectError) {
              Logger.error(`Failed to reconnect to ${this.serverName}:`, reconnectError);
              
              if (this.onerror) {
                this.onerror(new Error(`Failed to reconnect to SSE server: ${reconnectError}`));
              }
            }
          } else {
            // Max reconnect attempts reached
            this.connected = false;
            
            if (this.onerror) {
              this.onerror(new Error(`SSE connection failed after ${this.maxReconnectAttempts} attempts`));
            }
          }
        };
      }
      
      // Wait for connection to establish with timeout
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timeout connecting to SSE server ${this.serverName}`));
        }, 5000);
        
        if (this.eventSource) {
          this.eventSource.onopen = () => {
            clearTimeout(timeout);
            this.connected = true;
            resolve();
          };
        } else {
          reject(new Error(`Failed to create EventSource for ${this.serverName}`));
        }
      });
    } catch (error) {
      Logger.error(`Error starting SSE transport for ${this.serverName}:`, error);
      throw error;
    }
  }
  
  async send(message: JSONRPCMessage): Promise<void> {
    try {
      // Check if we're connected, if not try to reconnect
      if (!this.connected) {
        Logger.debug(`SSE transport not connected for ${this.serverName}, attempting to reconnect...`);
        try {
          await this.start();
          Logger.debug(`Reconnected to ${this.serverName}, proceeding with message send`);
        } catch (reconnectError) {
          throw new Error(`Failed to reconnect to SSE server: ${reconnectError}`);
        }
      }
      
      // Send message via fetch POST request to the server
      Logger.debug(`Sending message to ${this.serverName}:`, message);
      
      // Set up fetch with an AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(this.serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });
      
      // Clear the timeout
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP error when sending to ${this.serverName}: ${response.status} ${response.statusText}`);
      }
      
      Logger.debug(`Successfully sent message to ${this.serverName}`);
      return Promise.resolve();
    } catch (error) {
      Logger.error(`Error sending message to ${this.serverName}:`, error);
      
      // Mark as disconnected if it's a connection error
      if (error instanceof Error && 
          (error.message.includes('ECONNREFUSED') || 
           error.message.includes('timeout') ||
           error.message.includes('network') ||
           error.message.includes('failed'))) {
        this.connected = false;
      }
      
      if (this.onerror && error instanceof Error) {
        this.onerror(error);
      }
      return Promise.reject(error);
    }
  }
  
  async close(): Promise<void> {
    try {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
        this.connected = false;
      }
      
      if (this.onclose) {
        this.onclose();
      }
      
      return Promise.resolve();
    } catch (error) {
      Logger.error('Error closing SSE transport:', error);
      if (this.onerror && error instanceof Error) {
        this.onerror(error);
      }
      return Promise.reject(error);
    }
  }
  
  // These will be set by the Client
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
}

// Get server details
interface ServerDetail {
  url: string;
  name: string;
}

// Map of SSE server URLs by name
const sseServers = new Map<string, ServerDetail>();

// Register an SSE server
export function registerSSEServer(name: string, url: string, force: boolean = false): void {
  // If server was previously registered and force is false, just return
  if (sseServers.has(name) && !force) {
    Logger.info(`Server '${name}' already registered. Use force=true to re-register.`);
    return;
  }
  
  // If server was previously registered, clean up any existing client
  if (sseServers.has(name)) {
    Logger.debug(`Server '${name}' was previously registered, cleaning up...`);
    
    // Remove from SSE servers map
    sseServers.delete(name);
    
    // If we have a connected client, close it
    if (connectedClients.has(name)) {
      const client = connectedClients.get(name);
      if (client) {
        try {
          // Clean up any open connections
          (client as any)._transport?.close?.();
        } catch (error) {
          // Ignore errors in cleanup
          Logger.debug(`Error while cleaning up client for '${name}':`, error);
        }
      }
      
      // Remove from connected clients
      connectedClients.delete(name);
    }
  }
  
  // Now register the server with the new URL
  sseServers.set(name, { name, url });
  Logger.info(`Registered SSE server '${name}' at ${url}`);
}

// Unregister a server to force reconnection on next use
export function unregisterSSEServer(name: string): void {
  // Check if the server is registered
  if (!sseServers.has(name)) {
    Logger.warn(`No SSE server registered with name '${name}'`);
    return;
  }
  
  // If we have a connected client, close it
  if (connectedClients.has(name)) {
    const client = connectedClients.get(name);
    if (client) {
      try {
        // Clean up any open connections
        (client as any)._transport?.close?.();
      } catch (error) {
        // Ignore errors in cleanup
        Logger.debug(`Error while cleaning up client for '${name}':`, error);
      }
    }
    
    // Remove from connected clients
    connectedClients.delete(name);
  }
  
  // Remove from SSE servers map
  sseServers.delete(name);
  Logger.info(`Unregistered SSE server '${name}'`);
}

// Get or create a client for a server
async function getClient(serverName: string): Promise<Client> {
  // Check if we already have a connected client
  if (connectedClients.has(serverName)) {
    return connectedClients.get(serverName)!;
  }
  
  try {
    // Check if we have server details
    const serverDetail = sseServers.get(serverName);
    if (!serverDetail) {
      throw new ServerNotFoundError(serverName);
    }
    
    // Create transport for the SSE server
    const transport = new SSETransport(serverName, serverDetail.url);
    
    // Create the client
    const client = new Client({
      name: `test-client-${serverName}`,
      version: '0.1.0',
      transport
    });
    
    // Connect to the server
    Logger.debug(`Connecting to SSE server '${serverName}' at ${serverDetail.url}...`);
    await client.connect(transport);
    Logger.debug(`Connected to SSE server '${serverName}'`);
    
    // Cache the client for future use
    connectedClients.set(serverName, client);
    
    return client;
  } catch (error) {
    Logger.error(`Error creating client for server '${serverName}':`, error);
    throw new ToolCallError(
      serverName,
      'connect',
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Call a tool on a server
export async function callTool(input: CallToolInput): Promise<CallToolResponse> {
  const { server_name, tool_name, arguments: args } = input;
  const startTime = Date.now();
  
  try {
    // First, check if we have a cached client
    let client: Client;
    if (connectedClients.has(server_name)) {
      // We have a cached client, but let's verify it's still connected
      client = connectedClients.get(server_name)!;
      
      // Perform a quick health check - if it fails, we'll create a new client
      try {
        Logger.debug(`Verifying cached connection to server '${server_name}'`);
        
        // Set up fetch with an AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        
        await fetch(sseServers.get(server_name)?.url || '', { 
          method: 'HEAD',
          signal: controller.signal
        });
        
        // Clear the timeout
        clearTimeout(timeoutId);
      } catch (error) {
        // Connection appears to be broken, remove it from cache
        Logger.debug(`Cached connection to server '${server_name}' is broken, will reconnect`);
        connectedClients.delete(server_name);
        
        // Get a fresh client
        client = await getClient(server_name);
      }
    } else {
      // No cached client, create a new one
      client = await getClient(server_name);
    }
    
    // Call the tool
    Logger.debug(`Calling tool '${tool_name}' on server '${server_name}'`, args);
    const response = await client.callTool({
      name: tool_name, 
      arguments: args
    });
    
    const duration = Date.now() - startTime;
    Logger.debug(`Tool call completed in ${duration}ms`, response);
    
    // Extract the result from the response
    let result = response;
    
    // Handle different response formats
    if (response && response.content && Array.isArray(response.content)) {
      // Handle standard MCP response format
      const textContent = response.content.find((item: any) => item.type === 'text');
      if (textContent && textContent.text) {
        try {
          // Try to parse JSON from text content
          result = JSON.parse(textContent.text);
        } catch (e) {
          // If not valid JSON, use the text directly
          result = textContent.text;
        }
      }
    }
    
    return {
      result,
      duration_ms: duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    Logger.error(`Error calling tool '${tool_name}' on server '${server_name}':`, error);
    
    // If the error suggests the server is down or inaccessible,
    // remove it from the cache to force a reconnection on next attempt
    if (error instanceof Error && 
        (error.message.includes('ECONNREFUSED') ||
         error.message.includes('timeout') ||
         error.message.includes('not connected'))) {
      Logger.debug(`Removing cached connection to server '${server_name}' due to connectivity error`);
      connectedClients.delete(server_name);
    }
    
    return {
      result: null,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: duration
    };
  }
}

// List tools available on a server
export async function listTools(serverName: string): Promise<string[]> {
  try {
    // Get client for this server
    const client = await getClient(serverName);
    
    // List tools
    Logger.debug(`Listing tools for server '${serverName}'`);
    const response = await client.listTools();
    
    // Debug the response
    Logger.debug(`Tool list response:`, response);
    
    // Extract tools from the response
    let tools = response?.tools || [];
    
    // Debug the extracted tools
    Logger.debug(`Extracted ${tools.length} tools from response`);
    
    return tools.map((tool: { name: string }) => tool.name);
  } catch (error) {
    Logger.error(`Error listing tools for server '${serverName}':`, error);
    throw new ToolCallError(
      serverName,
      'listTools',
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Run a single test case
async function runTestCase(serverName: string, test: TestCase): Promise<TestResult> {
  const startTime = Date.now();
  
  try {
    // Call the tool
    const result = await callTool({
      server_name: serverName,
      tool_name: test.tool,
      arguments: test.input
    });
    
    const duration = Date.now() - startTime;
    
    // Check for errors
    if (result.error) {
      return {
        name: test.name,
        passed: false,
        message: `Tool call failed: ${result.error}`,
        duration_ms: duration,
        error: result.error
      };
    }
    
    // If there's an expected result, check it
    if (test.expected) {
      let passed = false;
      
      if (test.expected.type === 'equals') {
        passed = JSON.stringify(result.result) === JSON.stringify(test.expected.value);
      } else if (test.expected.type === 'contains') {
        const resultStr = JSON.stringify(result.result);
        const expectedStr = JSON.stringify(test.expected.value);
        passed = resultStr.includes(expectedStr);
      } else if (test.expected.type === 'regex') {
        const regex = new RegExp(test.expected.value);
        passed = regex.test(JSON.stringify(result.result));
      }
      
      return {
        name: test.name,
        passed,
        message: passed ? 'Test passed' : 'Test failed: result did not match expected value',
        duration_ms: duration
      };
    }
    
    // If no expected result, assume success
    return {
      name: test.name,
      passed: true,
      message: 'Test passed',
      duration_ms: duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    
    return {
      name: test.name,
      passed: false,
      message: `Test failed with error: ${error instanceof Error ? error.message : String(error)}`,
      duration_ms: duration,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Run tests for a server
export async function runTests(input: RunTestsInput): Promise<RunTestsResponse> {
  const { server_name, test_suite } = input;
  const startTime = Date.now();
  
  try {
    // For now, we'll just run a basic test to list tools
    // In a real implementation, this would load test suites from files
    
    // First, let's check that the server exists
    getServerProcess(server_name);
    
    // Get the tools available on the server
    const tools = await listTools(server_name);
    
    // Create a basic test for each tool
    const basicTests: TestCase[] = tools.map(tool => ({
      name: `List ${tool} schema`,
      description: `Check that ${tool} is available and has a valid schema`,
      tool,
      // Send an empty input just to see if the tool exists
      // This will likely fail for most tools, but will show the schema
      input: {}
    }));
    
    // Run each test
    const results: TestResult[] = [];
    for (const test of basicTests) {
      const result = await runTestCase(server_name, test);
      results.push(result);
    }
    
    // Calculate summary
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const failed = total - passed;
    const duration = Date.now() - startTime;
    
    return {
      results,
      summary: {
        total,
        passed,
        failed,
        duration_ms: duration
      }
    };
  } catch (error) {
    Logger.error(`Error running tests for server '${server_name}':`, error);
    
    if (error instanceof ServerNotFoundError) {
      throw error;
    }
    
    const duration = Date.now() - startTime;
    
    return {
      results: [{
        name: 'Test suite setup',
        passed: false,
        message: `Failed to setup test suite: ${error instanceof Error ? error.message : String(error)}`,
        duration_ms: duration,
        error: error instanceof Error ? error.message : String(error)
      }],
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        duration_ms: duration
      }
    };
  }
}