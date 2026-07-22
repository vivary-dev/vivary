import { getCollection } from 'astro:content';

export async function getStaticPaths() {
  const lessons = await getCollection('course');
  return lessons.map((lesson) => ({ params: { slug: lesson.id }, props: { lesson } }));
}

export async function GET({ props }) {
  const { lesson } = props;
  const metadata = JSON.stringify(
    {
      ...lesson.data,
      html: `https://vivary.vercel.app/learn/${lesson.id}/`,
      markdown: `https://vivary.vercel.app/learn/${lesson.id}.md`,
    },
    null,
    2,
  );
  const document = [
    `# ${lesson.data.title}`,
    '',
    lesson.data.description,
    '',
    '## Structured metadata and interaction answer model',
    '',
    '```json',
    metadata,
    '```',
    '',
    lesson.body,
    '',
  ].join('\n');

  return new Response(document, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
