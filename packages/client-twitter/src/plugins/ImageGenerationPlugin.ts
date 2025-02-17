import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
    generateText,
    generateImage,
    ModelClass,
    ModelProviderName,
} from "@elizaos/core";
import { ClientBase } from "../base";
import { type IKeywordPlugin, type IKeywordAction } from "./KeywordActionPlugin";
import path from "path";
import fs from "fs";

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

        const recraftApiKey = runtime.getSetting("RECRAFT_API_KEY");
        if (!recraftApiKey) {
            throw new Error("RECRAFT_API_KEY is required for image generation");
        }

        if (runtime.character) {
            runtime.character.imageModelProvider = ModelProviderName.RECRAFT;
            // Set the API key in runtime settings
            runtime.character.settings = {
                ...runtime.character.settings,
                secrets: {
                    ...runtime.character.settings?.secrets,
                    RECRAFT_API_KEY: recraftApiKey
                }
            };
        }
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
            const IMAGE_SYSTEM_PROMPT = `You are an expert in writing prompts for AI art generation, specializing in web3, DeFi, and blockchain visuals. You excel at creating detailed and creative visual descriptions for token icons, NFTs, and other blockchain-related imagery. Your prompts should emphasize modern, professional, and innovative design elements suitable for financial and technological applications. Always aim for clear, descriptive language that generates a creative picture. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`;

            let promptContext = "";
            if (params.type === 'token') {
                promptContext = `Create a professional and modern token icon for a cryptocurrency/token named "${params.name}". ${params.description ? `The token is described as: ${params.description}.` : ''} The style should be ${params.style || 'modern and minimalist'}. The icon should be suitable for listing on cryptocurrency exchanges and DeFi platforms.`;
            } else {
                promptContext = `Create a unique NFT artwork themed around "${params.name}". ${params.description ? `The artwork should represent: ${params.description}.` : ''} The style should be ${params.style || 'digital art'}. The artwork should be suitable for blockchain NFT marketplaces.`;
            }

            const IMAGE_PROMPT_INPUT = `You are tasked with generating a web3/DeFi-focused image prompt.
            Your goal is to create a detailed and professional prompt that captures the essence of ${params.type === 'token' ? 'a token icon' : 'an NFT artwork'}.

            Content to work with:
            ${promptContext}

            A good web3 image prompt should include:
            1. Main subject (token symbol/icon elements or NFT theme)
            2. Style and design elements
            3. Color scheme
            4. Lighting and effects
            5. Composition
            6. Professional/financial context


            Create a prompt that is detailed, professional, and suitable for the web3/DeFi space. LIMIT the image prompt to 50 words or less.`;

            const imagePrompt = await generateText({
                runtime: this.runtime,
                context: IMAGE_PROMPT_INPUT,
                modelClass: ModelClass.MEDIUM,
                customSystemPrompt: IMAGE_SYSTEM_PROMPT,
            });

            elizaLogger.info("Generated image prompt:", imagePrompt);

            // Create generatedImages directory if it doesn't exist
            const imageDir = path.join(process.cwd(), "generatedImages");
            if (!fs.existsSync(imageDir)) {
                fs.mkdirSync(imageDir, { recursive: true });
            }

            const images = await generateImage(
                {
                    prompt: imagePrompt,
                    width: 1024,
                    height: 1024,
                    count: 1,
                    stylePreset: params.type === 'token' ? "digital_illustration" : "digital_art",
                },
                this.runtime
            );

            if (images.success && images.data && images.data.length > 0) {
                const image = images.data[0];
                const filename = `${params.type}_${params.name}_${Date.now()}`;
                const filepath = path.join(imageDir, `${filename}.png`);

                // Save the image
                if (image.startsWith('http')) {
                    const response = await fetch(image);
                    const arrayBuffer = await response.arrayBuffer();
                    fs.writeFileSync(filepath, Buffer.from(arrayBuffer));
                } else {
                    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
                    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
                }

                return {
                    success: true,
                    imageUrl: filepath
                };
            } else {
                throw new Error("Image generation failed or returned no data");
            }
        } catch (error) {
            elizaLogger.error("ImageGenerationPlugin: Error generating image:", {
                error: error instanceof Error ? error.message : String(error),
                params
            });
            
            return {
                success: false,
                error: error instanceof Error ? error.message : "Image generation failed"
            };
        }
    }

    private registerActions() {
        const generateTokenImageAction: IKeywordAction = {
            name: "generate_token_image",
            description: "Generate a professional token icon or NFT artwork",
            examples: [
                "@movebot generate token icon MOVE modern style",
                "@movebot create NFT artwork CryptoKitties cute digital art",
                "@movebot generate token logo BTC minimalist gold"
            ],
            requiredParameters: [
                {
                    name: "type",
                    prompt: "What type of image do you want? (token/nft)",
                    validator: async (value: string) => ['token', 'nft'].includes(value.toLowerCase())
                },
                {
                    name: "name",
                    prompt: "What's the name or symbol for your token/NFT?",
                    validator: async (value: string) => value.length >= 1 && value.length <= 50
                },
                {
                    name: "style",
                    prompt: "What style would you like? (e.g., modern, minimalist, abstract, digital art)",
                    validator: async (value: string) => value.length >= 1 && value.length <= 50,
                
                },
                {
                    name: "description",
                    prompt: "Add a brief description for better results (optional)",
                    validator: async (value: string) => !value || value.length <= 200
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("ImageGenerationPlugin: Processing image generation with params:", Object.fromEntries(params));
                
                const generationParams: ImageGenerationParams = {
                    type: params.get("type") as 'token' | 'nft',
                    name: params.get("name"),
                    style: params.get("style"),
                    description: params.get("description")
                };

                const result = await this.generateImage(generationParams);

                if (result.success) {
                    return {
                        response: `✨ ${generationParams.type === 'token' ? 'Token icon' : 'NFT artwork'} generated successfully!\n\n${generationParams.type === 'token' ? 'You can use this icon for your token' : 'Your NFT artwork is ready'}. Check the attached image!`,
                        data: { imageUrl: result.imageUrl },
                        action: "IMAGE_GENERATED",
                        attachments: [
                            {
                                path: result.imageUrl,
                                type: "image/png"
                            }
                        ]
                    };
                } else {
                    return {
                        response: `❌ ${result.error || "Image generation failed. Please try again later."}`,
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(generateTokenImageAction);
    }
} 