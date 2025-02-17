import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime, 
    type Memory, 
    type Content, 
    elizaLogger,
    stringToUuid,
    getEmbeddingZeroVector,
    type UUID,
    composeContext,
    generateText,
    ModelClass
} from "@elizaos/core";
import { ClientBase } from "../base";
import { TwitterInteractionClient } from "../interactions";
import { KeywordActionPlugin, type IKeywordAction, type IParameterRequirement } from "./KeywordActionPlugin";
import { sendTweet, buildConversationThread } from "../utils";
import { Scraper } from "agent-twitter-client";

const keywordResponseTemplate = `
# Task: Generate a natural conversational response for {{agentName}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}

Context:
{{context}}

Previous conversation:
{{conversationHistory}}

Action result:
{{actionResult}}

# Instructions:
1. Generate a natural, conversational response that:
   - Acknowledges the user's request
   - Maintains the agent's personality and style
   - Incorporates the action result naturally
   - Keeps the response concise and Twitter-appropriate
2. The response should feel helpful and engaging while staying true to {{agentName}}'s character
3. Avoid generic responses - make it personal and contextual

Generate only the response text, no other commentary.
`;

export class TwitterKeywordService extends TwitterInteractionClient {
    private keywordPlugin: KeywordActionPlugin;
    private activeConversations: Map<string, {
        lastInteraction: number;
        context: string[];
        actionState: string;
    }> = new Map();
    private readonly CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    private targetUsers: string[] = [];
    private searchEnabled: boolean = false;
    protected twitterClient: Scraper;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        super(client, runtime);
        this.keywordPlugin = new KeywordActionPlugin(client, runtime);
        this.twitterClient = client.twitterClient;
        this.targetUsers = this.client.twitterConfig.TWITTER_TARGET_USERS || [];
        this.searchEnabled = this.client.twitterConfig.TWITTER_SEARCH_ENABLE || false;
        
        // Cleanup stale conversations periodically
        setInterval(() => this.cleanupStaleConversations(), 5 * 60 * 1000);
    }

    private cleanupStaleConversations() {
        const now = Date.now();
        for (const [userId, conversation] of this.activeConversations.entries()) {
            if (now - conversation.lastInteraction > this.CONVERSATION_TIMEOUT) {
                this.activeConversations.delete(userId);
            }
        }
    }

    private updateConversationContext(userId: string, message: string, isUser: boolean) {
        let conversation = this.activeConversations.get(userId);
        if (!conversation) {
            conversation = {
                lastInteraction: Date.now(),
                context: [],
                actionState: 'initial'
            };
            this.activeConversations.set(userId, conversation);
        }

        conversation.lastInteraction = Date.now();
        conversation.context.push(`${isUser ? 'User' : 'Bot'}: ${message}`);
        
        // Keep context manageable by limiting to last 10 messages
        if (conversation.context.length > 10) {
            conversation.context = conversation.context.slice(-10);
        }
    }

    private async generateNaturalResponse(
        tweet: Tweet,
        actionResult: string,
        context: string
    ): Promise<string> {
        const conversation = this.activeConversations.get(tweet.userId);
        const conversationHistory = conversation ? conversation.context.join('\n') : '';

        const memory: Memory = {
            id: stringToUuid(tweet.id + "-response"),
            userId: stringToUuid(tweet.userId),
            agentId: this.runtime.agentId,
            roomId: stringToUuid(tweet.id),
            content: { text: tweet.text || "" },
            embedding: getEmbeddingZeroVector(),
            createdAt: Date.now()
        };

        const state = await this.runtime.composeState(memory, {
            context,
            conversationHistory,
            actionResult
        });

        const promptContext = composeContext({
            state,
            template: keywordResponseTemplate
        });

        const response = await generateText({
            runtime: this.runtime,
            context: promptContext,
            modelClass: ModelClass.SMALL
        });

        return response.trim();
    }

    registerKeywordAction(
        name: string,
        description: string,
        examples: string[],
        requiredParams: IParameterRequirement[],
        action: (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => Promise<{
            response: string;
            data?: any;
        }>
    ) {
        const keywordAction: IKeywordAction = {
            name,
            description,
            examples,
            requiredParameters: requiredParams,
            action
        };
        this.keywordPlugin.registerAction(keywordAction);
    }

    public async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }): Promise<{ text: string; action: string }> {
        try {
            // Update conversation context with user's message
            this.updateConversationContext(tweet.userId, tweet.text || "", true);

            // Process with keyword plugin
            const keywordResult = await this.keywordPlugin.processTweet(tweet);
            
            if (keywordResult.hasAction) {
                let response: string;
                
                if (keywordResult.needsMoreInput) {
                    // Use the plugin's response directly for parameter collection
                    response = keywordResult.response;
                } else {
                    // Generate a natural response incorporating the action result
                    response = await this.generateNaturalResponse(
                        tweet,
                        keywordResult.response,
                        thread.map(t => `${t.username}: ${t.text}`).join('\n')
                    );
                }

                // Update conversation context with bot's response
                this.updateConversationContext(tweet.userId, response, false);

                // Send the response
                await sendTweet(
                    this.client,
                    { text: response },
                    message.roomId,
                    this.client.twitterConfig.TWITTER_USERNAME,
                    tweet.id
                );

                return { 
                    text: response, 
                    action: keywordResult.action || 'RESPOND'
                };
            }

            // If no keyword action matched, handle normally using parent class
            return super.handleTweet({ tweet, message, thread });
        } catch (error) {
            elizaLogger.error("Error in handleTweet:", error);
            const errorResponse = "I encountered an issue processing your request. Could you try again?";
            
            await sendTweet(
                this.client,
                { text: errorResponse },
                message.roomId,
                this.client.twitterConfig.TWITTER_USERNAME,
                tweet.id
            );

            return { text: errorResponse, action: 'ERROR' };
        }
    }
    
    async start() {
        const handleTwitterInteractionsLoop = async () => {
            try {
                elizaLogger.info("Starting to fetch timeline for actions...");
                elizaLogger.info(`Target users: ${this.targetUsers.join(", ")}`);
                
                const timeline = await this.client.fetchTimelineForActions(100);
                elizaLogger.info(`Retrieved timeline with ${timeline?.length || 0} tweets`);
                
                if (!timeline || timeline.length === 0) {
                    elizaLogger.warn("Timeline is empty or null");
                    elizaLogger.info("Timeline response:", JSON.stringify(timeline));
                    return;
                }

                for (const tweet of timeline) {
                    const userId = stringToUuid(tweet.userId);
                    const roomId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

                    await this.runtime.ensureConnection(
                        userId,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const content: Content = {
                        text: tweet.text || "",
                        url: tweet.permanentUrl,
                        source: "twitter",
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                            : undefined,
                    };

                    const memory = {
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId,
                        content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: tweet.timestamp ? tweet.timestamp * 1000 : Date.now(),
                    };

                    await this.runtime.messageManager.createMemory(memory);

                    const thread = await buildConversationThread(tweet, this.client);
                    
                    await this.handleTweet({
                        tweet,
                        message: memory,
                        thread,
                    });
                }

                elizaLogger.log("Finished processing Twitter interactions");
            } catch (error) {
                elizaLogger.error("Error in Twitter keyword service:", error);
            }
        };

        // Start the interaction loop
        handleTwitterInteractionsLoop();
        setInterval(handleTwitterInteractionsLoop, 60000); // Check every minute
    }

    // Add method to get registered actions
    public getRegisteredActions(): IKeywordAction[] {
        return this.keywordPlugin.getActions();
    }

    async fetchTimelineForActions() {
        
    }
}

// Example usage:
/*
const twitterService = new TwitterKeywordService(client, runtime);

// Register keyword actions
twitterService.registerKeywordAction(
    ["help", "commands"],
    async (tweet, runtime) => {
        return {
            response: "Here are the available commands: ...",
        };
    }
);

// Start the service
await twitterService.start();
*/ 