import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime, 
    elizaLogger
} from "@elizaos/core";
import { ClientBase } from "../base";
import { KeywordActionPlugin, type IKeywordAction } from "./KeywordActionPlugin";

export class MovebotPlugin {
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private keywordPlugin: KeywordActionPlugin;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.keywordPlugin = new KeywordActionPlugin(client, runtime);
        elizaLogger.info("MovebotPlugin: Initialized");
    }

    public async processSingleTweet(tweet: Tweet, thread: Tweet[]): Promise<{
        response: string;
        action?: string;
    }> {
        try {
            elizaLogger.info("MovebotPlugin: Processing tweet:", { 
                id: tweet.id, 
                text: tweet.text,
                username: tweet.username 
            });
            
            // Log available actions
            const actions = this.keywordPlugin.getActions();
            elizaLogger.info("MovebotPlugin: Available actions:", 
                actions.map(a => ({ name: a.name, examples: a.examples }))
            );
            
            // Clean up tweet text - handle newlines and extra spaces
            const cleanText = tweet.text.replace(/\s+/g, ' ').trim();
            elizaLogger.info("MovebotPlugin: Cleaned tweet text:", cleanText);
            
            // Process tweet through keyword plugin
            const result = await this.keywordPlugin.processTweet({
                ...tweet,
                text: cleanText
            });
            
            elizaLogger.info("MovebotPlugin: Keyword processing result:", { 
                hasAction: result.hasAction,
                action: result.action,
                needsMoreInput: result.needsMoreInput,
                response: result.response
            });
            
            if (result.hasAction) {
                if (result.needsMoreInput) {
                    elizaLogger.info("MovebotPlugin: Needs more input for action");
                    return {
                        response: result.response || "Could you provide more details for the transfer?",
                        action: "COLLECT_PARAMS"
                    };
                }

                // If action was executed
                if (result.data) {
                    elizaLogger.info("MovebotPlugin: Action executed successfully with data:", result.data);
                    // Handle movebot-specific success/failure responses
                    const txId = result.data.transactionId;
                    if (txId) {
                        return {
                            response: `Transaction successful! Reference ID: ${txId}`,
                            action: "EXECUTE_ACTION"
                        };
                    }
                }

                return {
                    response: result.response || "",
                    action: result.action || "EXECUTE_ACTION"
                };
            }

            elizaLogger.info("MovebotPlugin: No action needed for tweet");
            return {
                response: "",
                action: "NORMAL"
            };
        } catch (error) {
            elizaLogger.error("MovebotPlugin: Error processing tweet:", error);
            return {
                response: "I encountered an error processing your request. Could you try again?",
                action: "ERROR"
            };
        }
    }

    // Register movebot-specific actions
    public registerKeywordAction(action: IKeywordAction): void {
        elizaLogger.info("MovebotPlugin: Registering action:", {
            name: action.name,
            description: action.description,
            examples: action.examples
        });
        this.keywordPlugin.registerAction(action);
    }
} 