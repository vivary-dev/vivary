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
				'Lightweight local-first governed context for agent work. Create a five-file workspace, retrieve bounded evidence, verify work, and cross deliberate human gates.',
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
						{ label: 'Guide library', slug: 'learn-by-doing' },
						{ label: 'White paper', slug: 'white-paper' },
						{ label: 'Roadmap', link: '/roadmap/' },
						{ label: 'Blog', link: '/blog/' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Create a workspace', slug: 'guides/create-workspace' },
						{ label: 'Connect an agent', slug: 'guides/connect-agent' },
						{ label: 'Get bounded context', slug: 'guides/get-context' },
						{ label: 'Write one approved record', slug: 'guides/write-record' },
						{ label: 'Adopt an existing project', slug: 'guides/adopt-project' },
						{ label: 'Verify and recover', slug: 'guides/verify-recover' },
						{ label: 'Advanced recipes', slug: 'howto' },
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
						{ label: 'MCP adapter (optional)', slug: 'mcp' },
						{ label: 'Architecture', slug: 'architecture' },
						{ label: 'Historical proof (0.3.1)', slug: 'walkthrough' },
						{ label: 'Obsidian (optional)', slug: 'obsidian' },
						{ label: 'Migration status', slug: 'migration-status' },
						{ label: 'Decisions', slug: 'decisions' },
						{ label: 'Changelog', slug: 'changelog' },
					],
				},
			],
		}),
	],
});
