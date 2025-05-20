/**
 * Utility function to wait for a specified duration
 * @param ms Duration to wait in milliseconds
 * @returns Promise that resolves after the specified duration
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
} 