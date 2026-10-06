// The marker must be naturally scrolled into the conversation, not scrolled by the test.
export async function waitForConversationViewport(marker, timeout = 30_000) {
  await marker.waitFor();
  await marker.evaluate((element, timeout) => new Promise((resolve, reject) => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0)) {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Conversation marker did not enter the viewport'));
    }, timeout);
    observer.observe(element);
  }), timeout);
}
