import { getCollection } from 'astro:content';

export async function GET() {
  const lessons = (await getCollection('course')).sort((a, b) => a.data.order - b.data.order);
  const sections = lessons.flatMap((lesson) => [
    `# ${String(lesson.data.order).padStart(2, '0')}. ${lesson.data.title}`,
    '',
    lesson.data.description,
    '',
    '## Structured metadata and interaction answer model',
    '',
    '```json',
    JSON.stringify(
      {
        ...lesson.data,
        html: `https://vivary.vercel.app/learn/${lesson.id}/`,
        markdown: `https://vivary.vercel.app/learn/${lesson.id}.md`,
      },
      null,
      2,
    ),
    '```',
    '',
    lesson.body,
    '',
    '---',
    '',
  ]);
  const document = [
    '# Learn Vivary — complete agent edition',
    '',
    'All seventeen canonical lessons in pedagogical order. Status labels are contractual: do not promote optional, planned, or experimental material to baseline Vivary.',
    '',
    ...sections,
  ].join('\n');

  return new Response(document, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
