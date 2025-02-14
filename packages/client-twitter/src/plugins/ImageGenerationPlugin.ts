import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
} from "@elizaos/core";
import { ClientBase } from "../base";
import { type IKeywordPlugin, type IKeywordAction } from "./KeywordActionPlugin";

export interface ImageGenerationParams {
    type: 'token' | 'nft';
    name: string;
    description?: string;
    style?: string;
}

export class ImageGenerationPlugin implements IKeywordPlugin {
    readonly name = "image-generation";
    readonly description = "Plugin for generating images for tokens and NFTs";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];

    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.registerActions();
        elizaLogger.info("ImageGenerationPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("ImageGenerationPlugin: Registered action:", {
            name: action.name,
            description: action.description
        });
    }

    private async generateImage(params: ImageGenerationParams): Promise<{
        success: boolean;
        imageUrl?: string;
        error?: string;
    }> {
        try {
            // TODO: Implement actual image generation using an AI service
            // This is a placeholder that would be replaced with actual AI image generation
            // For now, return a mock success
            return {
                success: true,
                imageUrl: "https://placeholder.com/token-icon.png"
            };
        } catch (error) {
            elizaLogger.error("ImageGenerationPlugin: Error generating image:", {
                error: error instanceof Error ? error.message : String(error),
                params
            });
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    private registerActions() {
        const generateTokenImageAction: IKeywordAction = {
            name: "generate_token_image",
            description: "Generate an image for a token",
            examples: [
                "@movebot generate image for token TEST",
                "@movebot create token icon TEST modern style",
                "@movebot generate token image TEST minimalist"
            ],
            requiredParameters: [
                {
                    name: "name",
                    prompt: "What's the name or symbol of your token?",
                    validator: (value: string) => value.length >= 1 && value.length <= 50
                },
                {
                    name: "style",
                    prompt: "What style would you like? (e.g., modern, minimalist, abstract)",
                    validator: (value: string) => value.length >= 1 && value.length <= 50
                },
                {
                    name: "description",
                    prompt: "Add a brief description for better results (optional)",
                    validator: (value: string) => !value || value.length <= 200
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("ImageGenerationPlugin: Processing image generation with params:", Object.fromEntries(params));
                
                const generationParams: ImageGenerationParams = {
                    type: 'token',
                    name: params.get("name"),
                    style: params.get("style"),
                    description: params.get("description")
                };

                const result = await this.generateImage(generationParams);

                if (result.success) {
                    return {
                        response: `✅ Image generated successfully!\n\nYou can use this image URL for your token:\n${result.imageUrl}`,
                        data: { imageUrl: result.imageUrl },
                        action: "IMAGE_GENERATED"
                    };
                } else {
                    return {
                        response: result.error || "Image generation failed. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(generateTokenImageAction);
    }
} 