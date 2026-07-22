import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

const sourceSchema = z.object({
	label: z.string(),
	url: z.string().url(),
	locator: z.string().optional(),
	sourceRef: z.string().default('dev'),
	verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const multipleChoiceSchema = z.object({
	id: z.string(),
	kind: z.literal('multiple-choice'),
	prompt: z.string(),
	options: z.array(z.object({
		text: z.string(),
		correct: z.boolean().default(false),
		feedback: z.string(),
	})).length(4).refine(
		(options) => options.filter((option) => option.correct).length === 1,
		{ message: 'A multiple-choice interaction must have exactly one correct option.' },
	),
	success: z.string(),
	reveal: z.string(),
});

const interactionSchema = z.discriminatedUnion('kind', [
	multipleChoiceSchema,
	z.object({
		id: z.string(),
		kind: z.literal('sequence'),
		prompt: z.string(),
		items: z.array(z.object({
			text: z.string(),
			feedback: z.string(),
		})).min(2),
		success: z.string(),
		reveal: z.string(),
	}),
]);

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	blog: defineCollection({
		loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
		schema: z.object({
			title: z.string(),
			description: z.string(),
			date: z.coerce.date(),
			author: z.string().default('Jeff Kazzee'),
			tags: z.array(z.string()).default([]),
			draft: z.boolean().default(false),
		}),
	}),
	course: defineCollection({
		loader: glob({ pattern: '**/*.md', base: './src/content/course' }),
		schema: z.object({
			title: z.string(),
			shortTitle: z.string(),
			description: z.string(),
			order: z.number().int().min(1).max(17),
			module: z.string(),
			moduleTitle: z.string(),
			status: z.enum([
				'Baseline',
				'Optional layer',
				'Optional sidecar',
				'Planned',
				'Experimental',
				'Neighbor',
			]),
			minutes: z.number().int().positive(),
			tags: z.array(z.string()).default([]),
			outcomes: z.array(z.string()).min(1).max(3),
			sources: z.array(sourceSchema).min(1),
			interactions: z.array(interactionSchema).min(1).refine(
				(interactions) => new Set(interactions.map((interaction) => interaction.id)).size === interactions.length,
				{ message: 'Interaction ids must be unique within a lesson.' },
			),
		}),
	}),
};
