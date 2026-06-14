// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://vivary.vercel.app',
	integrations: [
		starlight({
			title: 'Vivary',
			description:
				'The create-t3-app for agent workspaces — a typed knowledge graph, a self-improving loop, and graph-aware review. Plain Markdown. Any editor. Any agent.',
			logo: { src: './src/assets/vivary.svg', alt: 'Vivary' },
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/vivary-dev/vivary' },
			],
			editLink: {
				baseUrl: 'https://github.com/vivary-dev/vivary/edit/dev/site/',
			},
			customCss: ['./src/styles/theme.css'],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Home', link: '/' },
						{ label: 'Getting started', slug: 'getting-started' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'How-to recipes', slug: 'howto' },
						{ label: 'Agent skills', slug: 'skills' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Command reference', slug: 'commands' },
						{ label: 'Architecture', slug: 'architecture' },
						{ label: 'FAQ', slug: 'faq' },
						{ label: 'Obsidian (optional)', slug: 'obsidian' },
					],
				},
			],
		}),
	],
});
