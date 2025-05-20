# Hyperbolic GPU MCP Server

This MCP server provides an interface to Hyperbolic's decentralized GPU network, allowing you to list available GPUs and rent instances.

## Setup

### Prerequisites

- Node.js 16 or higher
- npm or yarn
- A Hyperbolic API token
- (Optional) SSH private key for connecting to GPU instances

### Getting a Hyperbolic Account and API Token

1. Register for a Hyperbolic account:
   - Visit [https://app.hyperbolic.xyz/](https://app.hyperbolic.xyz/)
   - Create an account or log in to your existing account
   - Verify your email address

2. Deposit funds into your account:
   - Log in to your Hyperbolic application
   - Navigate to the "Billing" tab
   - Select how much you want to deposit (we suggest starting with $25)
   - Click Pay Now
   - Follow the instructions to add funds to your account
   - Note that you will need sufficient funds to rent GPU instances

3. Generate an API token:
   - In your Hyperbolic dashboard, navigate to "Settings" 
   - Navigate to the API Key section
   - Copy the generated token and keep it secure
   - You will use this key in your MCP server configuration environment variables

4. Add your SSH public key:
   - Generate an SSH key pair if you don't already have one
   - In your Hyperbolic application, navigate to the "Settings" section
   - Scroll down to the SSH Public Key section
   - Paste your public key (usually from ~/.ssh/id_rsa.pub or similar)
   - Click the save icon

### Installation

1. Clone this repository:

   ```bash
   git clone <your-repo-url>
   cd hyperbolic-mcp
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the TypeScript files:
   ```bash
   npm run build
   ```

## Usage

### Running the server locally

To run the server:

```bash
npm start
```

### Connecting with Claude for Desktop

1. Add the server to your Claude for Desktop config:

```json
{
  "mcpServers": {
    "hyperbolic-gpu": {
      "command": "node",
      "args": ["/path/to/hyperbolic-mcp-server/build/index.js"],
      "env": {
        "HYPERBOLIC_API_TOKEN": "your-hyperbolic-api-token",
        "SSH_PRIVATE_KEY_PATH": "/path/to/your/privatekey" 
      }
    }
  }
}
```

2. Restart Claude for Desktop.

3. Start a new conversation and interact with the server.

Note: You can provide environment variables either through the Claude Desktop config as shown above, or by creating a `.env` file in the project root. The `.env` file is only needed if you're not providing the variables through the config.

## Available Tools

The server provides the following tools:

### GPU Management Tools

#### list-available-gpus

Lists all available GPUs on the Hyperbolic network.

Example query: "Show me all available GPUs on Hyperbolic."

#### rent-gpu-instance

Rents a GPU instance from a specific cluster.

Parameters:

- `cluster_name`: The name of the cluster to rent (e.g., "extrasmall-chamomile-duck")
- `node_name`: The name of the node (e.g., "prd-acl-msi-02.fen.intra")
- `gpu_count`: Number of GPUs to rent

Example query: "I want to rent 4 GPUs from the extrasmall-chamomile-duck cluster."

#### terminate-gpu-instance

Terminates a GPU instance that you have rented.

Parameters:

- `instance_id`: The ID of the instance to terminate

Example query: "Terminate my GPU instance with ID abc123."

#### list-user-instances

Lists all active GPU instances that you have rented.

Example query: "Show me all my active GPU instances."

#### get-cluster-details

Gets detailed information about a specific cluster.

Parameters:

- `cluster_name`: The name of the cluster to get details for

Example query: "Tell me more about the cluster called extrasmall-chamomile-duck."

### SSH Tools

#### ssh-connect

Establishes an SSH connection to a remote server.

Parameters:

- `host`: Hostname or IP address of the remote server
- `username`: SSH username for authentication
- `password`: (Optional) SSH password for authentication
- `private_key_path`: (Optional) Path to private key file
- `port`: (Optional) SSH port number (default: 22)

Example query: "Connect to my GPU instance at 192.168.1.100 as user admin."

#### remote-shell

Executes a command on the connected remote server.

Parameters:

- `command`: Command to execute on the remote server

Example query: "Run 'nvidia-smi' on the connected server."

#### ssh-status

Checks the current SSH connection status.

Example query: "What's the status of my SSH connection?"

#### ssh-disconnect

Closes the active SSH connection.

Example query: "Disconnect from the SSH server."

## Security Notes

- This server requires your Hyperbolic API token and optionally an SSH private key
- These credentials can be provided either through the Claude Desktop config or a `.env` file
- The server only runs locally and doesn't expose your credentials externally
- Commands to rent GPUs will incur charges on your Hyperbolic account
- The SSH private key must not be password protected as the server cannot handle password-protected keys

## Troubleshooting

If you encounter issues:

1. Check that your API token is correct and not expired
2. Ensure you have sufficient credits on your Hyperbolic account
3. Check the server logs for error messages
4. Verify your network connection to the Hyperbolic API
5. If using SSH, verify that your private key path is correct and the key has the right permissions.

## License

[MIT License](LICENSE)
