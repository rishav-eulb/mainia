import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
    type Memory,
    type Content,
    stringToUuid,
    getEmbeddingZeroVector
} from "@elizaos/core";
import { ClientBase } from "../base";
import { TwitterInteractionClient } from "../interactions";
import { buildConversationThread, sendTweet } from "../utils";
import { SearchMode } from "agent-twitter-client";
import { TokenCreationPlugin } from "./TokenCreationPlugin";
import { TokenTransferPlugin } from "./TokenTransferPlugin";
import { TokenCreationPluginManager } from "./managers/TokenCreationPluginManager";
import { TokenTransferPluginManager } from "./managers/TokenTransferPluginManager";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { IConversationThread } from "../utils/conversation";

interface ITokenTransferResult {
    success: boolean;
    transactionId?: string;
    error?: string;
    additionalInfo?: string;
}

export class MovebotService extends TwitterInteractionClient {
    private orchestrator: Orchestrator;
    private tokenCreationPlugin: TokenCreationPlugin;
    private tokenTransferPlugin: TokenTransferPlugin;
    private tokenCreationManager: TokenCreationPluginManager;
    private tokenTransferManager: TokenTransferPluginManager;
    private processingLock: boolean = false;
    private static readonly BATCH_SIZE = 20;
    private isRunning: boolean = false;
    private retryCount: number = 0;
    private maxRetries: number = 5;
    protected static readonly PROCESSING_INTERVAL = 600; // 10 minutes
    private lastProcessedTweetId: string | null = null;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        super(client, runtime);
        
        // Initialize plugins
        this.tokenCreationPlugin = new TokenCreationPlugin();
        this.tokenTransferPlugin = new TokenTransferPlugin();
        
        // Initialize plugins with client and runtime
        this.tokenCreationPlugin.initialize(this.client, this.runtime);
        this.tokenTransferPlugin.initialize(this.client, this.runtime);
        
        // Initialize orchestrator with client and runtime
        this.orchestrator = new Orchestrator(this.client, this.runtime);
        
        // Initialize plugin managers
        this.tokenCreationManager = new TokenCreationPluginManager(
            this.client,
            this.runtime
        );
        
        this.tokenTransferManager = new TokenTransferPluginManager(
            this.client,
            this.runtime,
            this.tokenTransferPlugin
        );

        // Register plugin managers with the orchestrator
        this.orchestrator.registerPluginManager(this.tokenCreationManager, {
            name: "token-creation",
            intents: ["create token", "mint token", "new token"],
            requiredParams: ["symbol", "name"],
            optionalParams: ["supply", "iconUrl", "projectUrl"],
            examples: [
                "create a new token called MyToken",
                "mint token MOVE",
                "create token with symbol MTK"
            ]
        });

        this.orchestrator.registerPluginManager(this.tokenTransferManager, {
            name: "token-transfer",
            intents: ["transfer", "send"],
            requiredParams: ["recipient", "amount", "token"],
            optionalParams: [],
            examples: [
                "send 1 MOVE to 0x123",
                "transfer 5 tokens to @user"
            ]
        });
        
        elizaLogger.info("MovebotService: Initialized with Orchestrator");
    }

    private async createMemoryFromTweet(tweet: Tweet): Promise<Memory> {
        const userId = stringToUuid(tweet.userId);
        const roomId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        await this.runtime.ensureConnection(
            userId,
            roomId,
            tweet.username,
            tweet.name,
            "twitter"
        );

        return {
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId,
            agentId: this.runtime.agentId,
            roomId,
            content: {
                text: tweet.text || "",
                url: tweet.permanentUrl,
                source: "twitter",
                inReplyTo: tweet.inReplyToStatusId
                    ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                    : undefined,
            },
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1000
        };
    }

    public async start() {
        if (!await this.ensureLogin()) {
            elizaLogger.error("Failed to initialize MovebotService, retrying in 30 seconds");
            setTimeout(() => this.start(), 30000);
            return;
        }

        // Ensure we have a valid profile
        if (!this.client.profile) {
            try {
                const username = this.client.twitterConfig.TWITTER_USERNAME;
                this.client.profile = await this.client.fetchProfile(username);
                elizaLogger.info("MovebotService: Fetched profile successfully");
            } catch (error) {
                elizaLogger.error("Failed to fetch Twitter profile, retrying in 30 seconds:", error);
                setTimeout(() => this.start(), 30000);
                return;
            }
        }

        elizaLogger.info("MovebotService: Starting service");
        this.isRunning = true;

        const handleTwitterInteractionsLoop = async () => {
            if (this.processingLock) {
                elizaLogger.debug("Tweet processing already in progress, skipping");
                return;
            }

            this.processingLock = true;
            try {
                const botUsername = this.client.twitterConfig.TWITTER_USERNAME;
                // elizaLogger.info("Searching for mentions...");
                
                // Ensure profile is still valid
                if (!this.client.profile) {
                    elizaLogger.warn("Profile not found, attempting to refresh...");
                    this.client.profile = await this.client.fetchProfile(botUsername);
                }
                
                const searchResults = await this.safeApiCall(() => 
                    this.client.fetchSearchTweets(
                        `@${botUsername}`,
                        MovebotService.BATCH_SIZE,
                        SearchMode.Latest
                    )
                );
                
                elizaLogger.debug("Search results:", {
                    success: !!searchResults?.tweets,
                    length: searchResults?.tweets?.length || 0
                });
                
                if (!searchResults?.tweets || searchResults.tweets.length === 0) {
                    elizaLogger.debug("No mentions found");
                    this.retryCount = 0;
                    return;
                }

                for (const tweet of searchResults.tweets) {
                    try {
                        if (this.lastProcessedTweetId && tweet.id <= this.lastProcessedTweetId) {
                            elizaLogger.debug("Tweet already processed, skipping:", tweet.id);
                            continue;
                        }

                        if ((!tweet || !tweet.userId || !tweet.id) && tweet.username !=="rishavj39" ) {
                            elizaLogger.warn("Invalid tweet object:", tweet);
                            continue;
                        }

                        const memoryId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
                        const existingMemory = await this.runtime.messageManager.getMemoryById(memoryId);
                        if (existingMemory) {
                            elizaLogger.debug("Tweet already processed, skipping:", tweet.id);
                            continue;
                        }

                        elizaLogger.debug("Processing mention:", {
                            id: tweet.id,
                            username: tweet.username,
                            text: tweet.text?.substring(0, 50)
                        });

                        const memory = await this.createMemoryFromTweet(tweet);
                        await this.runtime.messageManager.createMemory(memory);

                        const thread = await this.safeApiCall(() => 
                            buildConversationThread(tweet, this.client)
                        ) || [];
                        
                        await this.handleTweet({
                            tweet,
                            message: memory,
                            thread
                        });

                        this.lastProcessedTweetId = tweet.id;
                        await this.client.cacheTweet(tweet);

                    } catch (tweetError) {
                        elizaLogger.error("Error processing individual tweet:", {
                            tweetId: tweet?.id,
                            error: tweetError instanceof Error ? tweetError.message : String(tweetError),
                            stack: tweetError instanceof Error ? tweetError.stack : undefined
                        });
                        continue;
                    }
                }
                
                // elizaLogger.info("Finished processing Twitter mentions");
                this.retryCount = 0;
            } catch (error) {
                elizaLogger.error("MovebotService: Error in main loop:", {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    retryCount: this.retryCount
                });
                
                this.retryCount++;
                if (this.retryCount >= this.maxRetries) {
                    elizaLogger.error("MovebotService: Max retries reached, stopping service");
                    await this.stop();
                    return;
                }
                
                const backoffTime = Math.min(1000 * Math.pow(2, this.retryCount), 60000);
                elizaLogger.info(`Retrying in ${backoffTime}ms (attempt ${this.retryCount} of ${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            } finally {
                this.processingLock = false;
            }
        };

        await handleTwitterInteractionsLoop();
        setInterval(handleTwitterInteractionsLoop, MovebotService.PROCESSING_INTERVAL);
    }

    public override async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }): Promise<{ text: string; action: string }> {
        try {
            if (!tweet?.text) {
                elizaLogger.warn("Invalid tweet received:", tweet);
                return { text: "", action: "IGNORE" };
            }

            // Process with Orchestrator
            const conversationThread = await this.buildThreadFromTweets(thread);
            const response = await this.orchestrator.handleMessage(tweet, {
                conversationThread,
                metadata: {
                    isNewConversation: thread.length === 0,
                    lastInteractionTime: Date.now(),
                    previousIntent: await this.orchestrator.getLastIntent(tweet.userId)
                }
            });

            if (response.error) {
                await sendTweet(
                    this.client,
                    { text: response.error },
                    message.roomId,
                    this.client.twitterConfig.TWITTER_USERNAME,
                    tweet.id
                );
                return { text: response.error, action: "ERROR" };
            }

            if (response.response) {
                await sendTweet(
                    this.client,
                    { text: response.response },
                    message.roomId,
                    this.client.twitterConfig.TWITTER_USERNAME,
                    tweet.id
                );
            }

            if (response.action === 'EXECUTE') {
                elizaLogger.info('Executing action with collected parameters:', response);
                const result = await this.executeAction(response.intent, response.params);
                if (result.success) {
                    await sendTweet(
                        this.client,
                        { text: this.formatSuccessResponse(result) },
                        message.roomId,
                        this.client.twitterConfig.TWITTER_USERNAME,
                        tweet.id
                    );
                } else {
                    await sendTweet(
                        this.client,
                        { text: `Failed to execute action: ${result.error}` },
                        message.roomId,
                        this.client.twitterConfig.TWITTER_USERNAME,
                        tweet.id
                    );
                }
            }

            return {
                text: response.response || "",
                action: response.action || "RESPOND"
            };
        } catch (error) {
            elizaLogger.error("Error in MovebotService handleTweet:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                tweet: {
                    id: tweet?.id,
                    text: tweet?.text?.substring(0, 50)
                }
            });
            return {
                text: "I encountered an error processing your request. Could you try again?",
                action: "ERROR"
            };
        }
    }

    private async buildThreadFromTweets(tweets: Tweet[]): Promise<IConversationThread> {
        return {
            messages: tweets.map(t => t.text || '').filter(text => text.length > 0),
            lastMessageTimestamp: tweets.length > 0 ? tweets[tweets.length - 1].timestamp * 1000 : Date.now()
        };
    }

    private async executeAction(intent: string, params: Map<string, string>): Promise<ITokenTransferResult> {
        switch (intent) {
            case 'create token':
                return await this.tokenCreationManager.executeCreation(params);
            case 'transfer':
            case 'send':
                // Call the transfer method directly on the plugin
                return await this.tokenTransferPlugin.stage_execute({
                    username: params.get('username') || '',
                    recipient: params.get('recipient') || '',
                    amount: params.get('amount') || '',
                    token: params.get('token') || '',
                    tweetId: params.get('tweetId') || ''
                });
            default:
                return {
                    success: false,
                    error: `Unknown action: ${intent}`
                };
        }
    }

    private formatSuccessResponse(result: any): string {
        if (result.transactionId) {
            return `✅ Transaction successful!\nTransaction ID: ${result.transactionId}\n${result.additionalInfo || ''}`;
        }
        return result.message || '✅ Action completed successfully!';
    }

    public async stop(): Promise<void> {
        elizaLogger.info("MovebotService: Stopping service");
        this.isRunning = false;
        elizaLogger.info("MovebotService: Service stopped");
    }
} 