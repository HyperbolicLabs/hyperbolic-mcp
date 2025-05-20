import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from "dotenv";
import { sshManager } from "./ssh-manager.js";
import { wait } from "./utils.js";

// Load environment variables
dotenv.config();

// Hyperbolic API base URL
const HYPERBOLIC_API_BASE = "https://api.hyperbolic.xyz/v1";

// Create MCP server instance
const server = new McpServer({
  name: "hyperbolic-gpu-server",
  version: "1.0.0",
});

// Utility function to make authenticated API requests to Hyperbolic
async function makeHyperbolicRequest(
  endpoint: string,
  method: string = "GET",
  body?: any
) {
  const token = process.env.HYPERBOLIC_API_TOKEN;

  if (!token) {
    throw new Error("HYPERBOLIC_API_TOKEN environment variable is not set");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const requestOptions: RequestInit = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  };

  try {
    const response = await fetch(
      `${HYPERBOLIC_API_BASE}${endpoint}`,
      requestOptions
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Hyperbolic API error (${response.status}): ${errorText}`
      );
    }

    return await response.json();
  } catch (error) {
    console.error("Error making Hyperbolic API request:", error);
    throw error;
  }
}

// Utility function to format RAM values
function formatRAM(ramInMB: number): string {
  if (ramInMB >= 1048576) {
    // 1 TB in MB
    return `${(ramInMB / 1048576).toFixed(2)} TB`;
  } else if (ramInMB >= 1024) {
    // 1 GB in MB
    return `${(ramInMB / 1024).toFixed(2)} GB`;
  } else {
    return `${ramInMB} MB`;
  }
}

// Register tool for listing available GPUs
server.tool(
  "list-available-gpus",
  {
    filters: z
      .object({})
      .passthrough()
      .optional()
      .describe("Optional filters for GPU listing"),
  },
  async ({ filters = {} }) => {
    try {
      const data = await makeHyperbolicRequest("/marketplace", "POST", {
        filters,
      });

      if (!data.instances || !Array.isArray(data.instances)) {
        throw new Error("Invalid response format from Hyperbolic API");
      }

      // Format the response for better readability
      const availableGPUs = data.instances
        .filter((instance: any) => instance.status === "node_ready")
        .map((instance: any) => {
          // Extract GPU information
          const gpuModels = instance.hardware?.gpus
            ? [...new Set(instance.hardware.gpus.map((gpu: any) => gpu.model))]
            : ["Unknown"];

          const totalGPUs = instance.gpus_total || 0;
          const reservedGPUs = instance.gpus_reserved || 0;
          const availableGPUCount = totalGPUs - reservedGPUs;

          // Extract RAM and storage
          const totalRAM = instance.hardware?.ram?.[0]?.capacity || 0;
          const totalStorage = instance.hardware?.storage?.[0]?.capacity || 0;

          // Get price information
          const pricePerHour = instance.pricing?.price?.amount || 0;

          return {
            cluster_name: instance.cluster_name || "unknown",
            node_name: instance.id || "unknown",
            gpu_model: gpuModels.join(", "),
            gpu_count: totalGPUs,
            available_gpus: availableGPUCount,
            gpu_vram_gb: instance.hardware?.gpus?.[0]?.ram
              ? Math.round(instance.hardware.gpus[0].ram / 1024)
              : "Unknown",
            cpu_cores: instance.hardware?.cpus?.[0]?.virtual_cores || "Unknown",
            ram_gb: totalRAM,
            storage_gb: totalStorage,
            price_per_hour: `$${(pricePerHour / 100).toFixed(2)}`,
            reserved: instance.reserved ? "Yes" : "No",
            region: instance.location?.region || "Unknown",
          };
        })
        // Filter out instances with no available GPUs
        .filter((instance: any) => instance.available_gpus > 0);

      if (availableGPUs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "success",
                available_gpus: [],
                message: "No available GPU instances found. All instances are currently reserved or in use."
              }, null, 2)
            },
          ],
        };
      }

      // Format the response as JSON
      const jsonResponse = {
        status: "success",
        available_gpus: availableGPUs.map((gpu: {
          cluster_name: string;
          node_name: string;
          gpu_model: string;
          available_gpus: number;
          gpu_count: number;
          gpu_vram_gb: number | string;
          cpu_cores: number | string;
          ram_gb: number;
          storage_gb: number;
          price_per_hour: string;
          region: string;
          reserved: boolean;
        }) => ({
          cluster_name: gpu.cluster_name,
          node_name: gpu.node_name,
          gpu_model: gpu.gpu_model,
          gpu_count: {
            available: gpu.available_gpus,
            total: gpu.gpu_count
          },
          specifications: {
            vram_gb: gpu.gpu_vram_gb,
            cpu_cores: gpu.cpu_cores,
            ram_gb: gpu.ram_gb,
            storage_gb: gpu.storage_gb
          },
          pricing: {
            per_hour: gpu.price_per_hour
          },
          region: gpu.region,
          is_reserved: gpu.reserved
        })),
        total_available_instances: availableGPUs.length,
        rental_instructions: {
          tool: "rent-gpu-instance",
          required_parameters: ["cluster_name", "node_name", "gpu_count"]
        }
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(jsonResponse, null, 2)
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: (error as Error).message
            }, null, 2)
          },
        ],
        isError: true,
      };
    }
  }
);

// Register tool for renting a GPU instance
server.tool(
  "rent-gpu-instance",
  {
    cluster_name: z
      .string()
      .describe(
        "The name of the cluster to rent (e.g., extrasmall-chamomile-duck)"
      ),
    node_name: z
      .string()
      .describe("The name of the node (e.g., prd-acl-msi-02.fen.intra)"),
    gpu_count: z.number().int().min(1).describe("Number of GPUs to rent"),
  },
  async ({ cluster_name, node_name, gpu_count }) => {
    try {
      // First, verify that the cluster exists and has available GPUs
      const marketplaceData = await makeHyperbolicRequest(
        "/marketplace",
        "POST",
        { filters: {} }
      );

      if (
        !marketplaceData.instances ||
        !Array.isArray(marketplaceData.instances)
      ) {
        throw new Error("Invalid response format from Hyperbolic API");
      }

      // Find the specified cluster
      const instance = marketplaceData.instances.find(
        (i: any) => i.cluster_name === cluster_name && i.id === node_name
      );

      if (!instance) {
        return {
          content: [
            {
              type: "text",
              text: `Error: The specified cluster (${cluster_name}) or node (${node_name}) was not found. Please check the names and try again.`,
            },
          ],
          isError: true,
        };
      }

      // Check if the instance is available
      const availableGPUCount =
        (instance.gpus_total || 0) - (instance.gpus_reserved || 0);

      if (availableGPUCount < gpu_count) {
        return {
          content: [
            {
              type: "text",
              text: `Error: The requested number of GPUs (${gpu_count}) exceeds the available GPUs (${availableGPUCount}) on this cluster.`,
            },
          ],
          isError: true,
        };
      }

      // If validation passes, proceed with the rental
      const requestBody = {
        cluster_name,
        node_name,
        gpu_count,
      };

      const data = await makeHyperbolicRequest(
        "/marketplace/instances/create",
        "POST",
        requestBody
      );

      // Wait for 60 seconds to allow the instance to start up
      console.error("Waiting 60 seconds for the instance to start up...");
      await wait(60000);
      console.error("Wait complete. Instance should be ready for SSH connection.");

      // Format the response as JSON
      const jsonResponse = {
        status: "success",
        rental_details: {
          cluster_name,
          node_name,
          gpus_rented: gpu_count,
          instance_id: data.instance_id || null,
          status: data.status || "created"
        },
        hardware_details: {
          gpu_model: instance.hardware?.gpus?.[0]?.model || null,
          gpu_vram: instance.hardware?.gpus?.[0]?.ram ? formatRAM(instance.hardware.gpus[0].ram) : null,
          cpu: {
            model: instance.hardware?.cpus?.[0]?.model || null,
            virtual_cores: instance.hardware?.cpus?.[0]?.virtual_cores || null
          }
        },
        pricing: {
          amount: instance.pricing?.price?.amount || null,
          period: instance.pricing?.price?.period || "hour"
        },
        connection_info: data.connection_info || null,
        note: "Waited 60 seconds for instance startup. The instance should now be ready for SSH connection."
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(jsonResponse, null, 2)
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: (error as Error).message
            }, null, 2)
          },
        ],
        isError: true,
      };
    }
  }
);

// Register tool for terminating a GPU instance
server.tool(
  "terminate-gpu-instance",
  {
    instance_id: z
      .string()
      .describe("The ID of the instance to terminate"),
  },
  async ({ instance_id }) => {
    try {
      // First, verify that the instance exists and belongs to the user
      const instancesData = await makeHyperbolicRequest("/marketplace/instances");

      if (!instancesData.instances || !Array.isArray(instancesData.instances)) {
        throw new Error("Invalid response format from Hyperbolic API");
      }

      // Find the specified instance
      const instance = instancesData.instances.find(
        (i: any) => i.id === instance_id
      );

      if (!instance) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Instance with ID "${instance_id}" was not found. Please check the ID and try again.`,
            },
          ],
          isError: true,
        };
      }

      // Proceed with termination
      const requestBody = {
        id: instance_id,
      };

      const data = await makeHyperbolicRequest(
        "/marketplace/instances/terminate",
        "POST",
        requestBody
      );

      // Format the response in a more readable way
      const formattedResponse = `# GPU Instance Successfully Terminated!

## Termination Details
- Instance ID: ${instance_id}
- Status: Terminated

## Instance Information
- GPU Model: ${instance.instance?.hardware?.gpus?.[0]?.model || "Unknown"}
- GPU Count: ${instance.instance?.gpu_count || "Unknown"}
- Created: ${instance.created ? new Date(instance.created).toLocaleString() : "Unknown"}
- Terminated: ${new Date().toLocaleString()}

The instance has been terminated and all associated resources have been released.`;

      return {
        content: [
          {
            type: "text",
            text: formattedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error terminating GPU instance: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Register tool for getting details of a specific cluster
server.tool(
  "get-cluster-details",
  {
    cluster_name: z
      .string()
      .describe("The name of the cluster to get details for"),
  },
  async ({ cluster_name }) => {
    try {
      // First, get all instances
      const data = await makeHyperbolicRequest("/marketplace", "POST", {
        filters: {},
      });

      if (!data.instances || !Array.isArray(data.instances)) {
        throw new Error("Invalid response format from Hyperbolic API");
      }

      // Find the specific instance by cluster_name
      const instance = data.instances.find(
        (i: any) => i.cluster_name === cluster_name
      );

      if (!instance) {
        return {
          content: [
            {
              type: "text",
              text: `Cluster "${cluster_name}" not found. Please check the cluster name and try again.`,
            },
          ],
          isError: true,
        };
      }

      // Format detailed information in a more readable way
      const gpuInfo =
        instance.hardware?.gpus
          ?.map(
            (gpu: any, index: number) =>
              `GPU ${index + 1}: ${gpu.model || "Unknown"}, VRAM: ${formatRAM(
                gpu.ram || 0
              )}`
          )
          .join("\n") || "No GPU information available";

      const cpuInfo = instance.hardware?.cpus?.[0]
        ? `${instance.hardware.cpus[0].model || "Unknown"}, ${
            instance.hardware.cpus[0].virtual_cores || 0
          } virtual cores`
        : "No CPU information available";

      const ramInfo = instance.hardware?.ram?.[0]
        ? `${formatRAM(instance.hardware.ram[0].capacity || 0)}`
        : "No RAM information available";

      const storageInfo = instance.hardware?.storage?.[0]
        ? `${instance.hardware.storage[0].capacity || 0} GB`
        : "No storage information available";

      const pricing = instance.pricing?.price
        ? `${instance.pricing.price.amount || 0} per ${
            instance.pricing.price.period || "hour"
          }`
        : "Pricing information not available";

      const availableGPUCount =
        (instance.gpus_total || 0) - (instance.gpus_reserved || 0);
      const availabilityStatus =
        availableGPUCount > 0 ? "Available" : "Fully Reserved";

      // Format the response as JSON
      const jsonResponse = {
        status: "success",
        cluster_info: {
          name: cluster_name,
          node_name: instance.id || null,
          status: instance.status || null,
          availability_status: availabilityStatus,
          region: instance.location?.region || null,
          is_reserved: instance.reserved || false,
          has_persistent_storage: instance.has_persistent_storage || false
        },
        hardware_specs: {
          cpu: {
            model: instance.hardware?.cpus?.[0]?.model || null,
            virtual_cores: instance.hardware?.cpus?.[0]?.virtual_cores || null
          },
          ram: instance.hardware?.ram?.[0]?.capacity ? formatRAM(instance.hardware.ram[0].capacity) : null,
          storage: instance.hardware?.storage?.[0]?.capacity ? `${instance.hardware.storage[0].capacity} GB` : null,
          gpus: {
            total: instance.gpus_total || 0,
            available: availableGPUCount,
            reserved: instance.gpus_reserved || 0,
            details: instance.hardware?.gpus?.map((gpu: any, index: number) => ({
              index: index + 1,
              model: gpu.model || null,
              vram: gpu.ram ? formatRAM(gpu.ram) : null
            })) || []
          }
        },
        pricing: {
          amount: instance.pricing?.price?.amount || null,
          period: instance.pricing?.price?.period || "hour"
        },
        running_instances: instance.instances?.map((inst: any) => ({
          id: inst.id,
          status: inst.status,
          gpu_count: inst.hardware?.filter((h: any) => h.gpu).length || 0,
          storage: inst.hardware?.find((h: any) => h.storage)?.storage?.capacity || 0
        })) || [],
        rental_instructions: {
          tool: "rent-gpu-instance",
          parameters: {
            cluster_name: cluster_name,
            node_name: instance.id || "",
            gpu_count: Math.min(availableGPUCount, 1),
            max_available: availableGPUCount
          }
        }
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(jsonResponse, null, 2)
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: (error as Error).message
            }, null, 2)
          },
        ],
        isError: true,
      };
    }
  }
);

// Register SSH connection tool
server.tool(
  "ssh-connect",
  {
    host: z.string().describe("Hostname or IP address of the remote server"),
    username: z.string().describe("SSH username for authentication"),
    password: z
      .string()
      .optional()
      .describe("SSH password for authentication (optional if using key)"),
    private_key_path: z
      .string()
      .optional()
      .describe(
        "Path to private key file (optional, uses SSH_PRIVATE_KEY_PATH from environment if not provided)"
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(22)
      .describe("SSH port number (default: 22)"),
  },
  async ({ host, username, password, private_key_path, port }) => {
    try {
      // console.log(
      //   `Attempting SSH connection to ${host}:${port} as ${username}`
      // );
      const result = await sshManager.connect(
        host,
        username,
        password,
        private_key_path,
        port
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: result.startsWith("SSH Connection Error") || result.startsWith("SSH Key Error") ? "error" : "success",
              message: result
            }, null, 2)
          },
        ],
        isError: result.startsWith("SSH Connection Error") || result.startsWith("SSH Key Error"),
      };
    } catch (error) {
      console.error("SSH connection failed with error:", error);
      const errorMessage = error
        ? error instanceof Error
          ? error.message || "Unknown error"
          : String(error)
        : "Unknown error";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: errorMessage
            }, null, 2)
          },
        ],
        isError: true,
      };
    }
  }
);

// Register SSH command execution tool
server.tool(
  "remote-shell",
  {
    command: z.string().describe("Command to execute on the remote server"),
  },
  async ({ command }) => {
    try {
      if (!sshManager.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "No active SSH connection. Please connect first using the ssh-connect tool."
              }, null, 2)
            },
          ],
          isError: true,
        };
      }

      // console.log(`Executing remote command: ${command}`);
      const result = await sshManager.execute(command);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: result.startsWith("Error:") || result.startsWith("SSH Command Error:") ? "error" : "success",
              command,
              output: result || "(Command executed with no output)"
            }, null, 2)
          },
        ],
        isError: result.startsWith("Error:") || result.startsWith("SSH Command Error:"),
      };
    } catch (error) {
      console.error("SSH command execution error:", error);
      const errorMessage = error
        ? error instanceof Error
          ? error.message || "Unknown error"
          : String(error)
        : "Unknown error";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: errorMessage
            }, null, 2)
          },
        ],
        isError: true,
      };
    }
  }
);

// Register SSH status tool
server.tool("ssh-status", {}, async () => {
  try {
    const status = sshManager.getConnectionInfo();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            connection_status: status
          }, null, 2)
        },
      ],
    };
  } catch (error) {
    console.error("SSH status error:", error);
    const errorMessage = error
      ? error instanceof Error
        ? error.message || "Unknown error"
        : String(error)
      : "Unknown error";

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            error: errorMessage
          }, null, 2)
        },
      ],
      isError: true,
    };
  }
});

// Register SSH disconnect tool
server.tool("ssh-disconnect", {}, async () => {
  try {
    if (!sshManager.isConnected()) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "success",
              message: "No active SSH connection to disconnect."
            }, null, 2)
          },
        ],
      };
    }

    await sshManager.disconnect();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: "SSH connection closed successfully."
          }, null, 2)
        },
      ],
    };
  } catch (error) {
    console.error("SSH disconnect error:", error);
    const errorMessage = error
      ? error instanceof Error
        ? error.message || "Unknown error"
        : String(error)
      : "Unknown error";

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            error: errorMessage
          }, null, 2)
        },
      ],
      isError: true,
    };
  }
});

// Register tool for listing user's active instances
server.tool("list-user-instances", {}, async () => {
  try {
    const data = await makeHyperbolicRequest("/marketplace/instances");

    if (!data.instances || !Array.isArray(data.instances)) {
      throw new Error("Invalid response format from Hyperbolic API");
    }

    if (data.instances.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "success",
              instances: [],
              message: "You don't have any active instances on Hyperbolic."
            }, null, 2)
          },
        ],
      };
    }

    // Format the response as JSON
    const jsonResponse = {
      status: "success",
      instances: data.instances.map((instance: any, index: number) => ({
        id: instance.id || null,
        basic_info: {
          status: instance.instance?.status || null,
          created: instance.created ? new Date(instance.created).toISOString() : null,
          started: instance.start ? new Date(instance.start).toISOString() : null,
          ended: instance.end ? new Date(instance.end).toISOString() : null,
          owner_id: instance.instance?.owner || null
        },
        hardware: {
          cpu: {
            model: instance.instance?.hardware?.cpus?.[0]?.model || null,
            virtual_cores: instance.instance?.hardware?.cpus?.[0]?.virtual_cores || null
          },
          ram: instance.instance?.hardware?.ram?.[0]?.capacity ? formatRAM(instance.instance.hardware.ram[0].capacity) : null,
          storage: instance.instance?.hardware?.storage?.[0]?.capacity ? `${instance.instance.hardware.storage[0].capacity} GB` : null,
          gpus: {
            allocated: instance.instance?.gpu_count || 0,
            total: instance.instance?.gpus_total || 0,
            details: instance.instance?.hardware?.gpus?.map((gpu: any) => ({
              model: gpu.model || null,
              vram: gpu.ram ? formatRAM(gpu.ram) : null
            })) || []
          }
        },
        pricing: {
          amount: instance.instance?.pricing?.price?.amount || null,
          period: instance.instance?.pricing?.price?.period || "hour"
        },
        connection: {
          ssh_command: instance.sshCommand || null,
          port_mappings: instance.portMappings || []
        }
      })),
      total_instances: data.instances.length
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(jsonResponse, null, 2)
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            error: (error as Error).message
          }, null, 2)
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  console.error("Starting Hyperbolic GPU MCP Server...");
  await server.connect(transport);
  console.error("Hyperbolic GPU MCP Server connected and ready");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
