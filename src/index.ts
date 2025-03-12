import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from "dotenv";

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
          // Convert cents to dollars
          const pricePerHourDollars = (pricePerHour / 100).toFixed(2);

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
            price_per_hour: `$${pricePerHourDollars}`,
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
              text: "No available GPU instances found. All instances are currently reserved or in use.",
            },
          ],
        };
      }

      // Create a more human-readable table format
      const tableHeader = `| Cluster Name | Node Name | GPU Model | Available/Total GPUs | VRAM (GB) | CPU Cores | RAM (GB) | Storage (GB) | Price/Hour ($) | Region |\n| ----------- | --------- | --------- | ------------------ | --------- | --------- | ------- | ----------- | ------------- | ------ |`;

      const tableRows = availableGPUs.map(
        (gpu: {
          cluster_name: any;
          node_name: any;
          gpu_model: any;
          available_gpus: any;
          gpu_count: any;
          gpu_vram_gb: any;
          cpu_cores: any;
          ram_gb: any;
          storage_gb: any;
          price_per_hour: any;
          region: any;
        }) =>
          `| ${gpu.cluster_name} | ${gpu.node_name} | ${gpu.gpu_model} | ${gpu.available_gpus}/${gpu.gpu_count} | ${gpu.gpu_vram_gb} | ${gpu.cpu_cores} | ${gpu.ram_gb} | ${gpu.storage_gb} | ${gpu.price_per_hour} | ${gpu.region} |`
      );

      const tableOutput = [tableHeader, ...tableRows].join("\n");

      return {
        content: [
          {
            type: "text",
            text: `# Available GPU Instances on Hyperbolic\n\n${tableOutput}\n\nTo rent an instance, use the \`rent-gpu-instance\` tool with the cluster_name, node_name, and gpu_count parameters.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing available GPUs: ${(error as Error).message}`,
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

      return {
        content: [
          {
            type: "text",
            text: `Successfully rented GPU instance!\n\nDetails:\n${JSON.stringify(
              data,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renting GPU instance: ${(error as Error).message}`,
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

      const priceCents = instance.pricing?.price?.amount || 0;
      const priceDollars = (priceCents / 100).toFixed(2);
      const pricing = instance.pricing?.price
        ? `$${priceDollars} per ${instance.pricing.price.period || "hour"}`
        : "Pricing information not available";

      const availableGPUCount =
        (instance.gpus_total || 0) - (instance.gpus_reserved || 0);
      const availabilityStatus =
        availableGPUCount > 0 ? "Available" : "Fully Reserved";

      // Format the existing instances running on this node
      const existingInstances =
        instance.instances && instance.instances.length > 0
          ? instance.instances
              .map((inst: any) => {
                const gpuCount =
                  inst.hardware?.filter((h: any) => h.gpu).length || 0;
                const storage =
                  inst.hardware?.find((h: any) => h.storage)?.storage
                    ?.capacity || 0;
                return `- Instance ID: ${inst.id}, Status: ${inst.status}, GPUs: ${gpuCount}, Storage: ${storage} GB`;
              })
              .join("\n")
          : "No running instances";

      const detailedInfo = `# Cluster: ${cluster_name}

## Basic Information
- Node Name: ${instance.id || "Unknown"}
- Status: ${instance.status || "Unknown"} (${availabilityStatus})
- Region: ${instance.location?.region || "Unknown"}
- Reserved: ${instance.reserved ? "Yes" : "No"}
- Has Persistent Storage: ${instance.has_persistent_storage ? "Yes" : "No"}

## Hardware Specifications
- CPU: ${cpuInfo}
- RAM: ${ramInfo}
- Storage: ${storageInfo}
- Total GPUs: ${instance.gpus_total || 0}
- Available GPUs: ${availableGPUCount}
- Reserved GPUs: ${instance.gpus_reserved || 0}

## GPU Details
${gpuInfo}

## Pricing
- ${pricing}

## Running Instances
${existingInstances}

To rent GPUs from this cluster, use the \`rent-gpu-instance\` tool with the following parameters:
\`\`\`
{
  "cluster_name": "${cluster_name}",
  "node_name": "${instance.id || ""}",
  "gpu_count": ${Math.min(
    availableGPUCount,
    1
  )} // Specify how many GPUs you want to rent (up to ${availableGPUCount} available)
}
\`\`\``;

      return {
        content: [
          {
            type: "text",
            text: detailedInfo,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting cluster details: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

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
