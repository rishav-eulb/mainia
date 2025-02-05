let currentHeight: number;

export const heightState = {
    get current(): number {
        return currentHeight;
    },
    set current(height: number) {
        currentHeight = height;
    }
}; 