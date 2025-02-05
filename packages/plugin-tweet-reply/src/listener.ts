import { IAgentRuntime, Service, ServiceType, elizaLogger } from "@elizaos/core";
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { DEFAULT_NETWORK, MOVEMENT_NETWORK_CONFIG } from "./constants";
import { BlockProcessor } from "./block-processor";
import { getLastProcessedHeight } from "./storage";

let isInitialized = false;

export const tweetReplyListener: Service = {
    serviceType: ServiceType.BROWSER,
    
    initialize: async (runtime: IAgentRuntime) => {
        // Prevent multiple initializations
        if (isInitialized) {
            elizaLogger.warn("Tweet reply listener already initialized, skipping...");
            return;
        }

        try {
            elizaLogger.info("Starting tweet reply listener initialization...");
            
            // Initialize Aptos client
            const networkConfig = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
            if (!networkConfig) {
                throw new Error(`Invalid network configuration for ${DEFAULT_NETWORK}`);
            }

            const aptosClient = new Aptos(
                new AptosConfig({
                    network: Network.TESTNET,
                    fullnode: networkConfig.fullnode
                })
            );

            const botPortalAddress = runtime.getSetting("BOT_PORTAL_ADDRESS");
            if (!botPortalAddress) {
                throw new Error("BOT_PORTAL_ADDRESS is not configured");
            }

            // Get the last processed block height from storage
            const startBlock = await getLastProcessedHeight(runtime);
            const blockProcessor = new BlockProcessor(startBlock);

            // Start continuous block processing
            const processBlocks = async () => {
                await blockProcessor.processBlock(aptosClient, botPortalAddress, runtime);
                setTimeout(processBlocks, 1000); // Check for new blocks every second
            };

            processBlocks();
            isInitialized = true;

        } catch (error) {
            elizaLogger.error('Fatal error in tweet reply listener:', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
};