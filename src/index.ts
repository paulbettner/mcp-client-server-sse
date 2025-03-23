#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { deployServer, listServers, getServerLogs, stopServer } from './operations/docker.js';
import { callTool, runTests, registerSSEServer, unregisterSSEServer } from './operations/mcp-client.js';

import {
  DeployServerSchema,
  RegisterSSEServerSchema,
  UnregisterSSEServerSchema,
  CallToolSchema,
  GetLogsSchema,
  ListServersSchema,
  RunTestsSchema,
  ServerOperationSchema
} from './types/schemas.js';

import { VERSION } from './common/version.js';
import { Logger } from './common/logger.js';
import { MCPTestError } from './common/errors.js';

// Lock file path for single instance check
const LOCK_FILE_PATH = path.join(os.tmpdir(), 'mcp-client-server.lock');

// Check for other running instances
function checkExistingInstance() {
  try {
    if (fs.existsSync(LOCK_FILE_PATH)) {
      const lockData = fs.readFileSync(LOCK_FILE_PATH, 'utf8');
      const { pid, startTime } = JSON.parse(lockData);
      
      // Check if process with this PID exists
      try {
        // On POSIX systems, sending signal 0 checks existence without sending a signal
        process.kill(pid, 0);
        
        Logger.error(`Another MCP client server is already running (PID: ${pid})`);
        Logger.error(`If you're sure no other server is running, delete the lock file: ${LOCK_FILE_PATH}`);
        process.exit(1);
      } catch (e) {
        // Process doesn't exist, we can take over the lock
        Logger.warn(`Found stale lock file from process ${pid}. Taking over.`);
      }
    }
    
    // Write our lock file
    const lockData = JSON.stringify({
      pid: process.pid,
      startTime: new Date().toISOString(),
      hostname: os.hostname()
    });
    
    fs.writeFileSync(LOCK_FILE_PATH, lockData);
    
    // Register cleanup on exit
    const cleanupLock = () => {
      try {
        if (fs.existsSync(LOCK_FILE_PATH)) {
          const lockData = fs.readFileSync(LOCK_FILE_PATH, 'utf8');
          const { pid } = JSON.parse(lockData);
          
          // Only delete if it's our lock
          if (pid === process.pid) {
            fs.unlinkSync(LOCK_FILE_PATH);
            Logger.debug(`Removed lock file: ${LOCK_FILE_PATH}`);
          }
        }
      } catch (err) {
        Logger.error(`Error cleaning up lock file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    
    process.on('exit', cleanupLock);
    process.on('SIGINT', () => {
      cleanupLock();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanupLock();
      process.exit(0);
    });
    
    return true;
  } catch (err) {
    Logger.error(`Error checking for existing instances: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Initialize logger
Logger.init();

// Create MCP server instance
const server = new Server(
  {
    name: 'mcp-test-client',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Handle listing tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  Logger.debug('Handling list tools request');
  
  return {
    tools: [
      {
        name: 'mcp_test_register_sse_server',
        description: 'Register an external MCP server that uses SSE for communication',
        inputSchema: {
          type: 'object',
          properties: {
            name: { 
              type: 'string',
              description: 'Name for the SSE server'
            },
            url: { 
              type: 'string',
              description: 'URL endpoint of the SSE server'
            },
            force: {
              type: 'boolean',
              description: 'Force re-registration even if already registered',
              default: true
            }
          },
          required: ['name', 'url']
        }
      },
      {
        name: 'mcp_test_unregister_sse_server',
        description: 'Unregister a previously registered SSE server to force reconnection',
        inputSchema: {
          type: 'object',
          properties: {
            name: { 
              type: 'string',
              description: 'Name of the SSE server to unregister'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'mcp_test_deploy_server',
        description: 'Deploy an MCP server to a test environment',
        inputSchema: {
          type: 'object',
          properties: {
            name: { 
              type: 'string',
              description: 'Name for the deployed server'
            },
            source_path: { 
              type: 'string',
              description: 'Absolute path to the server source code'
            },
            env_vars: { 
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Environment variables to pass to the server'
            },
            persistent: { 
              type: 'boolean',
              description: 'Whether to keep the server running after tests',
              default: true
            }
          },
          required: ['name', 'source_path']
        }
      },
      {
        name: 'mcp_test_call_tool',
        description: 'Call a tool on a deployed MCP server',
        inputSchema: {
          type: 'object',
          properties: {
            server_name: { 
              type: 'string',
              description: 'Name of the deployed server to call'
            },
            tool_name: { 
              type: 'string',
              description: 'Name of the tool to call'
            },
            arguments: { 
              type: 'object',
              additionalProperties: true,
              description: 'Arguments to pass to the tool'
            }
          },
          required: ['server_name', 'tool_name', 'arguments']
        }
      },
      {
        name: 'mcp_test_get_logs',
        description: 'Get logs from a deployed MCP server',
        inputSchema: {
          type: 'object',
          properties: {
            server_name: { 
              type: 'string',
              description: 'Name of the deployed server'
            },
            lines: { 
              type: 'number',
              description: 'Number of log lines to return',
              default: 100
            }
          },
          required: ['server_name']
        }
      },
      {
        name: 'mcp_test_list_servers',
        description: 'List all deployed MCP servers',
        inputSchema: {
          type: 'object',
          properties: {
            status: { 
              type: 'string',
              enum: ['running', 'all'],
              description: 'Status of servers to list',
              default: 'running'
            }
          }
        }
      },
      {
        name: 'mcp_test_run_tests',
        description: 'Run tests against a deployed MCP server',
        inputSchema: {
          type: 'object',
          properties: {
            server_name: { 
              type: 'string',
              description: 'Name of the deployed server to test'
            },
            test_suite: { 
              type: 'string',
              description: 'Name of the test suite to run'
            },
            interactive: { 
              type: 'boolean',
              description: 'Whether to run tests interactively',
              default: false
            }
          },
          required: ['server_name']
        }
      },
      {
        name: 'mcp_test_stop_server',
        description: 'Stop a deployed MCP server',
        inputSchema: {
          type: 'object',
          properties: {
            server_name: { 
              type: 'string',
              description: 'Name of the deployed server'
            }
          },
          required: ['server_name']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  Logger.debug(`Handling tool call: ${name}`, args);

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  try {
    let result;
    
    switch (name) {
      case 'mcp_test_register_sse_server': {
        const input = RegisterSSEServerSchema.parse(args);
        registerSSEServer(input.name, input.url, input.force);
        result = {
          name: input.name,
          url: input.url,
          status: "registered"
        };
        break;
      }
      
      case 'mcp_test_unregister_sse_server': {
        const input = UnregisterSSEServerSchema.parse(args);
        unregisterSSEServer(input.name);
        result = {
          name: input.name,
          status: "unregistered"
        };
        break;
      }
      
      case 'mcp_test_deploy_server': {
        const input = DeployServerSchema.parse(args);
        result = await deployServer(input);
        break;
      }
      
      case 'mcp_test_call_tool': {
        const input = CallToolSchema.parse(args);
        result = await callTool(input);
        break;
      }
      
      case 'mcp_test_get_logs': {
        const input = GetLogsSchema.parse(args);
        result = await getServerLogs(input);
        break;
      }
      
      case 'mcp_test_list_servers': {
        const input = ListServersSchema.parse(args);
        result = await listServers(input);
        break;
      }
      
      case 'mcp_test_run_tests': {
        const input = RunTestsSchema.parse(args);
        result = await runTests(input);
        break;
      }
      
      case 'mcp_test_stop_server': {
        const input = ServerOperationSchema.parse(args);
        result = await stopServer(input);
        break;
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      isError: false
    };
  } catch (error) {
    Logger.error(`Error executing tool ${name}:`, error);
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof MCPTestError ? error.name : 'InternalServerError';
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: errorMessage,
            errorType: errorName
          }, null, 2)
        }
      ],
      isError: true
    };
  }
});

// Start the server
async function main() {
  try {
    Logger.info('Starting MCP Test Client...');
    
    // Check for existing instances
    if (!checkExistingInstance()) {
      Logger.error('Failed to initialize due to instance check failure');
      process.exit(1);
    }
    
    Logger.info(`MCP client server started with PID ${process.pid}`);
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    Logger.info('MCP Test Client running on stdio');
  } catch (error) {
    Logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  Logger.error('Fatal error in main():', error);
  process.exit(1);
});