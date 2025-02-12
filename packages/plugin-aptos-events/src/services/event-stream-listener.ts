import { IAgentRuntime, Provider, elizaLogger, Memory, State } from "@elizaos/core";
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";

export class EventStreamListener implements Provider {
    private aptosClient: Aptos;
    private lastProcessedHeight: number = 0;
    private isProcessing: boolean = false;
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000;

    constructor(
        private runtime: IAgentRuntime,
        private botPortalAddress: string,
        private network: Network,
        private fullnode: string
    ) {
        this.aptosClient = new Aptos(new AptosConfig({ 
            network,
            fullnode
        }));
    }

    async get(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<any> {
        // Initialize if not already done
        if (!this.aptosClient) {
            this.aptosClient = new Aptos(new AptosConfig({ 
                network: this.network,
                fullnode: this.fullnode
            }));
        }
        
        await this.start();
        return this;
    }

    async start() {
        if (this.isProcessing) {
            elizaLogger.debug("Event processing already in progress");
            return;
        }

        this.isProcessing = true;

        try {
            // Get the latest block height
            const latestBlock = await this.aptosClient.getBlockByHeight({
                blockHeight: BigInt(this.lastProcessedHeight),
                options: {
                    withTransactions: true
                }
            });

            if (!latestBlock) {
                elizaLogger.warn("No block found at height", this.lastProcessedHeight);
                return;
            }

            // Process events in the block
            const events = await this.aptosClient.view({
                payload: {
                    function: `${this.botPortalAddress}::events::get_events`,
                    typeArguments: [],
                    functionArguments: [BigInt(this.lastProcessedHeight)]
                }
            });

            if (events && Array.isArray(events) && events.length > 0) {
                for (const event of events) {
                    try {
                        await this.processEvent(event);
                    } catch (error) {
                        elizaLogger.error("Error processing event:", error);
                    }
                }
            }

            // Update last processed height
            this.lastProcessedHeight = Number(latestBlock.block_height);
            await this.saveLastProcessedHeight();

        } catch (error) {
            elizaLogger.error("Error in event stream listener:", error);
        } finally {
            this.isProcessing = false;
        }
    }

    private async processEvent(event: any) {
        // Process the event according to your needs
        elizaLogger.info("Processing event:", event);
    }

    private async saveLastProcessedHeight() {
        try {
            await this.runtime.cacheManager.set(
                'aptos_events/last_processed_height',
                this.lastProcessedHeight.toString()
            );
        } catch (error) {
            elizaLogger.error("Error saving last processed height:", error);
        }
    }

    private async loadLastProcessedHeight() {
        try {
            const savedHeight = await this.runtime.cacheManager.get('aptos_events/last_processed_height');
            if (savedHeight && typeof savedHeight === 'string') {
                this.lastProcessedHeight = parseInt(savedHeight, 10);
            }
        } catch (error) {
            elizaLogger.error("Error loading last processed height:", error);
        }
    }
} 