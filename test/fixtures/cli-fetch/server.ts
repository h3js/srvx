// Fixture: Streaming lorem ipsum text word by word
const loremIpsum =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";

export default {
  fetch: (): Response => {
    const words = loremIpsum.split(" ");
    let index = 0;

    const stream = new ReadableStream({
      async pull(controller) {
        if (index < words.length) {
          const word = words[index] + (index < words.length - 1 ? " " : "");
          controller.enqueue(new TextEncoder().encode(word));
          index++;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
