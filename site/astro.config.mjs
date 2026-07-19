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
				'Typed memory and gates for AI-agent projects. Scaffold a workspace your agent can navigate, verify, and trust: typed project memory, visible state, reusable skills, private boundaries, and gates. Plain Markdown. Any editor. Any agent.',
			logo: { src: './src/assets/vivary-mark.png', alt: 'Vivary' },
			favicon: '/favicon.png',
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
						{ label: 'What is Vivary?', slug: 'concepts' },
						{ label: 'Getting started', slug: 'getting-started' },
						{ label: 'Getting started proof', slug: 'walkthrough' },
						{ label: 'White paper', slug: 'white-paper' },
						{ label: 'Roadmap', link: '/roadmap/' },
						{ label: 'Blog', link: '/blog/' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'How-to recipes', slug: 'howto' },
						{ label: 'Agent skills', slug: 'skills' },
						{ label: 'Active context', slug: 'active-context' },
						{ label: 'LLM active-context guide', slug: 'llm-active-context' },
						{ label: 'Public signals', slug: 'signals' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Command reference', slug: 'commands' },
						{ label: 'Architecture', slug: 'architecture' },
						{ label: 'Obsidian (optional)', slug: 'obsidian' },
						{ label: 'Changelog', slug: 'changelog' },
					],
				},
			],
		}),
	],
});
