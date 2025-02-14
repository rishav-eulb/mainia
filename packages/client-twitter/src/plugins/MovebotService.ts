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
import { KeywordActionPlugin } from "./KeywordActionPlugin";
import { SearchMode } from "agent-twitter-client";
import { TokenTransferPlugin } from "./TokenTransferPlugin";
import { WalletManagementPlugin } from "./WalletManagementPlugin";
import { TokenFungibleTransferPlugin } from "./TokenFungibleTransferPlugin";
import { TokenOwnershipTransferPlugin } from "./TokenOwnershipTransferPlugin";
import { TokenCreationPlugin } from "./TokenCreationPlugin";
import { ImageGenerationPlugin } from "./ImageGenerationPlugin";

export class MovebotService extends TwitterInteractionClient {
    private keywordPlugin: KeywordActionPlugin;
    private tokenTransferPlugin: TokenTransferPlugin;
    private walletManagementPlugin: WalletManagementPlugin;
    private tokenFungibleTransferPlugin: TokenFungibleTransferPlugin;
    private tokenOwnershipTransferPlugin: TokenOwnershipTransferPlugin;
    private tokenCreationPlugin: TokenCreationPlugin;
    private imageGenerationPlugin: ImageGenerationPlugin;
    private processingLock: boolean = false;
    private static readonly BATCH_SIZE = 20;
    private isRunning: boolean = false;
    private retryCount: number = 0;
    private maxRetries: number = 3;
    protected static readonly PROCESSING_INTERVAL = 600; // 10 minutes
    private lastProcessedTweetId: string | null = null;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        super(client, runtime);
        this.keywordPlugin = new KeywordActionPlugin(client, runtime);
        this.tokenTransferPlugin = new TokenTransferPlugin();
        this.walletManagementPlugin = new WalletManagementPlugin();
        this.tokenFungibleTransferPlugin = new TokenFungibleTransferPlugin();
        this.tokenOwnershipTransferPlugin = new TokenOwnershipTransferPlugin();
        this.tokenCreationPlugin = new TokenCreationPlugin();
        this.imageGenerationPlugin = new ImageGenerationPlugin();
        
        // Initialize and register all plugins
        Promise.all([
            this.tokenTransferPlugin.initialize(client, runtime),
            this.walletManagementPlugin.initialize(client, runtime),
            this.tokenFungibleTransferPlugin.initialize(client, runtime),
            this.tokenOwnershipTransferPlugin.initialize(client, runtime),
            this.tokenCreationPlugin.initialize(client, runtime),
            this.imageGenerationPlugin.initialize(client, runtime)
        ]).then(() => {
            this.keywordPlugin.registerPlugin(this.tokenTransferPlugin);
            this.keywordPlugin.registerPlugin(this.walletManagementPlugin);
            this.keywordPlugin.registerPlugin(this.tokenFungibleTransferPlugin);
            this.keywordPlugin.registerPlugin(this.tokenOwnershipTransferPlugin);
            this.keywordPlugin.registerPlugin(this.tokenCreationPlugin);
            this.keywordPlugin.registerPlugin(this.imageGenerationPlugin);
            elizaLogger.info("MovebotService: All plugins registered");
        }).catch(error => {
            elizaLogger.error("MovebotService: Failed to initialize plugins:", error);
        });
        
        elizaLogger.info("MovebotService: Initialized");
    }

    private async createMemoryFromTweet(tweet: Tweet): Promise<Memory> {
        const userId = stringToUuid(tweet.userId);
        const roomId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        // Ensure connection exists
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
                elizaLogger.info("Searching for mentions...");
                
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
                
                // Add debug logging
                elizaLogger.debug("Search results:", {
                    success: !!searchResults?.tweets,
                    length: searchResults?.tweets?.length || 0
                });
                
                if (!searchResults?.tweets || searchResults.tweets.length === 0) {
                    elizaLogger.debug("No mentions found");
                    this.retryCount = 0; // Reset retry count as this is a valid state
                    return;
                }

                for (const tweet of searchResults.tweets) {
                    try {
                        // Skip if we've already processed this tweet
                        if (this.lastProcessedTweetId && tweet.id <= this.lastProcessedTweetId) {
                            elizaLogger.debug("Tweet already processed, skipping:", tweet.id);
                            continue;
                        }

                        // Validate tweet object
                        if (!tweet || !tweet.userId || !tweet.id) {
                            elizaLogger.warn("Invalid tweet object:", tweet);
                            continue;
                        }

                        // Check if tweet has already been processed
                        const memoryId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
                        const existingMemory = await this.runtime.messageManager.getMemoryById(memoryId);
                        if (existingMemory) {
                            elizaLogger.debug("Tweet already processed, skipping:", tweet.id);
                            continue;
                        }

                        elizaLogger.debug("Processing mention:", {
                            id: tweet.id,
                            username: tweet.username,
                            text: tweet.text?.substring(0, 50) // Log first 50 chars
                        });

                        // Create memory object for the tweet
                        const memory = await this.createMemoryFromTweet(tweet);

                        // Save the memory
                        await this.runtime.messageManager.createMemory(memory);

                        // Build conversation thread for context
                        const thread = await this.safeApiCall(() => 
                            buildConversationThread(tweet, this.client)
                        ) || [];
                        
                        // Process the tweet
                        await this.handleTweet({
                            tweet,
                            message: memory,
                            thread
                        });

                        // Update last processed tweet ID
                        this.lastProcessedTweetId = tweet.id;

                        // Cache the tweet as processed
                        await this.client.cacheTweet(tweet);

                    } catch (tweetError) {
                        elizaLogger.error("Error processing individual tweet:", {
                            tweetId: tweet?.id,
                            error: tweetError instanceof Error ? tweetError.message : String(tweetError),
                            stack: tweetError instanceof Error ? tweetError.stack : undefined,
                            tweet: {
                                id: tweet?.id,
                                username: tweet?.username,
                                text: tweet?.text?.substring(0, 50)
                            }
                        });
                        continue;
                    }
                }
                
                elizaLogger.info("Finished processing Twitter mentions");
                this.retryCount = 0; // Reset retry count on successful execution
            } catch (error) {
                elizaLogger.error("MovebotService: Error in main loop:", {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    retryCount: this.retryCount,
                    isRunning: this.isRunning,
                    processingLock: this.processingLock
                });
                
                this.retryCount++;
                if (this.retryCount >= this.maxRetries) {
                    elizaLogger.error("MovebotService: Max retries reached, stopping service", {
                        totalRetries: this.retryCount,
                        maxRetries: this.maxRetries
                    });
                    await this.stop();
                    return;
                }
                
                // Exponential backoff for retries
                const backoffTime = Math.min(1000 * Math.pow(2, this.retryCount), 60000);
                elizaLogger.info(`Retrying in ${backoffTime}ms (attempt ${this.retryCount} of ${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            } finally {
                this.processingLock = false;
            }
        };

        // Initial processing
        await handleTwitterInteractionsLoop();

        // Set up interval for subsequent processing
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

            // Process with KeywordActionPlugin directly
            const result = await this.safeApiCall(async () => 
                this.keywordPlugin.processTweet(tweet)
            );
            
            // Handle null/undefined result from safeApiCall
            if (!result) {
                elizaLogger.warn("No result from keyword plugin processing:", {
                    tweetId: tweet.id,
                    text: tweet.text
                });
                return {
                    text: "I'm having trouble processing your request right now. Please try again later.",
                    action: "ERROR"
                };
            }
            
            if (result.hasAction) {
                elizaLogger.info("MovebotService: Plugin processing result:", {
                    action: result.action,
                    needsMoreInput: result.needsMoreInput,
                    hasResponse: !!result.response
                });
                
                // If we need more input, just send the response asking for it
                if (result.needsMoreInput) {
                    if (result.response) {
                        await this.safeApiCall(async () => {
                            await sendTweet(
                                this.client,
                                { text: result.response },
                                message.roomId,
                                this.client.twitterConfig.TWITTER_USERNAME,
                                tweet.id
                            );
                        });
                    }
                    return {
                        text: result.response || "Need more information",
                        action: "NEED_INPUT"
                    };
                }

                // Send the response back to the user
                if (result.response) {
                    await this.safeApiCall(async () => {
                        await sendTweet(
                            this.client,
                            { text: result.response },
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweet.id
                        );
                    });
                }

                return {
                    text: result.response || "",
                    action: result.action || "RESPOND"
                };
            }

            // If no keyword action was taken, fall back to parent class handling
            return super.handleTweet({ tweet, message, thread });
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

    public async stop(): Promise<void> {
        elizaLogger.info("MovebotService: Stopping service");
        this.isRunning = false;
        elizaLogger.info("MovebotService: Service stopped");
    }
} 