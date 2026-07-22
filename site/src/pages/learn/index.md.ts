import { getCollection } from 'astro:content';

export async function GET() {
  const lessons = (await getCollection('course')).sort((a, b) => a.data.order - b.data.order);
  const lessonLines = lessons.flatMap((lesson) => [
    `## ${String(lesson.data.order).padStart(2, '0')}. ${lesson.data.title}`,
    '',
    `- Module: ${lesson.data.module} — ${lesson.data.moduleTitle}`,
    `- Status: ${lesson.data.status}`,
    `- Time: ${lesson.data.minutes} minutes`,
    `- HTML: https://vivary.vercel.app/learn/${lesson.id}/`,
    `- Markdown: https://vivary.vercel.app/learn/${lesson.id}.md`,
    `- Description: ${lesson.data.description}`,
    '',
  ]);
  const document = [
    '# Learn Vivary — agent-readable course index',
    '',
    'Canonical, source-grounded lessons on operating, debugging, extending, and defending a Vivary workspace.',
    'Full course bundle: https://vivary.vercel.app/learn/course.md',
    '',
    '',
    'The `Status` field is part of the contract. Baseline, optional, planned, and experimental material must not be conflated.',
    '',
    ...lessonLines,
  ].join('\n');

  return new Response(document, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
