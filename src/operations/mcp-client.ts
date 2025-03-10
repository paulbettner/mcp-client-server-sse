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
import EventSource from 'eventsource';
import fetch from 'node-fetch';

// Cache of connected clients by server name
const connectedClients = new Map<string, Client>();

// Create a custom Transport implementation for SSE communication
class SSETransport implements Transport {
  private eventSource: EventSource | null = null;
  private messageQueue: JSONRPCMessage[] = [];
  private connected = false;
  private serverUrl: string;
  
  constructor(serverName: string, serverUrl: string) {
    this.serverUrl = serverUrl;
    Logger.debug(`Creating SSE transport for server '${serverName}' at ${serverUrl}`);
  }
  
  async start(): Promise<void> {
    try {
      // Create an EventSource for SSE connections
      this.eventSource = new EventSource(this.serverUrl);
      Logger.debug(`Established SSE connection to ${this.serverUrl}`);
      
      // Set up event handlers
      this.eventSource.onopen = () => {
        Logger.debug('SSE connection opened');
        this.connected = true;
      };
      
      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as JSONRPCMessage;
          Logger.debug('Received SSE message:', data);
          
          if (this.onmessage) {
            this.onmessage(data);
          }
        } catch (error) {
          Logger.error('Error parsing SSE message:', error);
          if (this.onerror && error instanceof Error) {
            this.onerror(error);
          }
        }
      };
      
      this.eventSource.onerror = (error) => {
        Logger.error('SSE connection error:', error);
        if (this.onerror) {
          this.onerror(new Error('SSE connection error'));
        }
      };
      
      // Wait for connection to establish
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout connecting to SSE server'));
        }, 5000);
        
        this.eventSource!.onopen = () => {
          clearTimeout(timeout);
          this.connected = true;
          resolve();
        };
      });
    } catch (error) {
      Logger.error('Error starting SSE transport:', error);
      throw error;
    }
  }
  
  async send(message: JSONRPCMessage): Promise<void> {
    try {
      if (!this.connected) {
        throw new Error('SSE transport not connected');
      }
      
      // Send message via fetch POST request to the server
      const response = await fetch(this.serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }
      
      Logger.debug('Sent message to SSE server:', message);
      return Promise.resolve();
    } catch (error) {
      Logger.error('Error sending message via SSE transport:', error);
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
export function registerSSEServer(name: string, url: string): void {
  sseServers.set(name, { name, url });
  Logger.info(`Registered SSE server '${name}' at ${url}`);
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
    // Get client for this server
    const client = await getClient(server_name);
    
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