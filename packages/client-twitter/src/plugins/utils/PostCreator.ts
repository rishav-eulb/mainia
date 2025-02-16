import puppeteer from "puppeteer";
import { PinataSDK } from "pinata-web3";
import { elizaLogger } from "@elizaos/core";
import { string } from "zod";

export class TweetImageUploader {
    private pinata: PinataSDK;
    private browserPath: string = "/snap/bin/chromium"; // Adjust for your system

    constructor() {
        const pinataJwt = process.env.PINATA_JWT;
        if (!pinataJwt) {
            throw new Error("Missing PINATA_JWT in .env file");
        }

        this.pinata = new PinataSDK({
            pinataJwt,
            pinataGateway: "coral-raw-meadowlark-631.mypinata.cloud",
        });
    }

    /**
     * Fetches the Base64-encoded image from a tweet.
     * @param tweetUrl - The tweet URL to convert into an image.
     * @returns Base64 string of the image.
     */
    private async fetchImageBase64(tweetUrl: string): Promise<string | null> {
        const browser = await puppeteer.launch({ headless: false, executablePath: this.browserPath });
        try {
            const page = await browser.newPage();
        
            // Navigate to the tweet-to-image converter
            await page.goto("https://10015.io/tools/tweet-to-image-converter");

            // Input tweet URL
            await page.type("#tweetUrl", tweetUrl);
            await page.click("#__next > main > div > div > div > div.sc-bcXHqe.sc-gswNZR.filuRp.bbLVwL > div:nth-child(2) > button");

            // Wait for the image to appear
            await page.waitForSelector("#__next > main > div > div > div > div.sc-be18d063-0.gmdLNk > div > div > div > div > div > svg > image");

            // Extract Base64 image URL
            const base64Image = await page.evaluate(() => {
                const img = document.querySelector("#__next > main > div > div > div > div.sc-be18d063-0.gmdLNk > div > div > div > div > div > svg > image") as HTMLImageElement | null;
                return img ? img.getAttribute("href") || img.getAttribute("xlink:href") || img.getAttribute("src") : null;
            });
            return base64Image?.replace("data:image/png;base64,", "") ?? null;
        } catch (error) {
            elizaLogger.error("error in fetching image", error instanceof Error ? error.message: String(error))
            throw error
        } finally {
            await browser.close()
        }
    }

    /**
     * Uploads the image to Pinata IPFS.
     * @param base64Image - The Base64 image string.
     * @returns The IPFS URL of the uploaded image.
     */
    private async uploadToPinata(base64Image: string): Promise<string | null> {
        try {
            const upload = await this.pinata.upload.base64(base64Image);
            return `https://gateway.pinata.cloud/ipfs/${upload.IpfsHash}`;
        } catch (error) {
            console.error("Error uploading to Pinata:", error);
            return null;
        }
    }

    /**
     * Uploads a tweet's image to IPFS and returns the IPFS URL.
     * @param tweetUrl - The tweet URL to process.
     * @returns IPFS URL of the uploaded image.
     */
    public async uploadTweetImage(tweetUrl: string): Promise<string | null> {
        elizaLogger.info("Fetching tweet image...");
        let base64Image: string;
        try {
            base64Image = await this.fetchImageBase64(tweetUrl);
            if (!base64Image) {
                elizaLogger.error("Failed to retrieve image.");
                return null;
            }
        } catch(error) {
            throw Error("error in generating image for the tweet. Kindly retry.")
        }
        

        elizaLogger.info("Uploading image to IPFS...");
        const ipfsUrl = await this.uploadToPinata(base64Image);

        if (ipfsUrl) {
            elizaLogger.info("Image successfully uploaded to IPFS:", ipfsUrl);
        } else {
            elizaLogger.error("Image upload failed.");
        }

        return ipfsUrl;
    }
}