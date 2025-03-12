# Hyperbolic GPU MCP Server

This MCP server provides an interface to Hyperbolic's decentralized GPU network, allowing you to list available GPUs and rent instances.

## Setup

### Prerequisites

- Node.js 16 or higher
- npm or yarn
- A Hyperbolic API token

### Installation

1. Clone this repository:

   ```bash
   git clone <your-repo-url>
   cd hyperbolic-mcp-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file with your Hyperbolic API token:

   ```bash
   cp .env.example .env
   ```

   Edit the `.env` file and replace the placeholder token with your actual Hyperbolic API token.

4. Build the TypeScript files:
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
      "args": ["/path/to/hyperbolic-mcp-server/build/index.js"]
    }
  }
}
```

2. Restart Claude for Desktop.

3. Start a new conversation and interact with the server.

## Available Tools

The server provides the following tools:

### list-available-gpus

Lists all available GPUs on the Hyperbolic network.

Example query: "Show me all available GPUs on Hyperbolic."

### rent-gpu-instance

Rents a GPU instance from a specific cluster.

Parameters:

- `cluster_name`: The name of the cluster to rent (e.g., "extrasmall-chamomile-duck")
- `node_name`: The name of the node (e.g., "prd-acl-msi-02.fen.intra")
- `gpu_count`: Number of GPUs to rent

Example query: "I want to rent 4 GPUs from the extrasmall-chamomile-duck cluster."

### get-cluster-details

Gets detailed information about a specific cluster.

Parameters:

- `cluster_name`: The name of the cluster to get details for

Example query: "Tell me more about the cluster called extrasmall-chamomile-duck."

## Security Notes

- This server requires your Hyperbolic API token stored in the `.env` file
- The token grants access to your Hyperbolic account, so keep it secure
- The server only runs locally and doesn't expose your token externally
- Commands to rent GPUs will incur charges on your Hyperbolic account

## Troubleshooting

If you encounter issues:

1. Check that your API token is correct and not expired
2. Ensure you have sufficient credits on your Hyperbolic account
3. Check the server logs for error messages
4. Verify your network connection to the Hyperbolic API

## License

[MIT License](LICENSE)
