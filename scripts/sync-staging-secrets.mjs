#!/usr/bin/env node
import { spawn } from 'node:child_process';
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const ALLOWED_KEYS = [
	'CLIENT_ID',
	'CLIENT_SECRET',
	'REFRESH_TOKEN',
	'USERS',
	'ROOT_ID',
	'WEBDAV_PATH',
	'NAME',
];

function printHelp() {
	console.log(`Usage: node scripts/sync-staging-secrets.mjs [options]

Reads allowed Worker runtime bindings from an .env file and uploads them as
Cloudflare Worker secrets via \`wrangler secret bulk\`.
Never includes X_DEV_GATE or unrelated variables, and never prints secret values.

Allowed keys: ${ALLOWED_KEYS.join(', ')}

Options:
  --config <path>    Wrangler config file (default: wrangler.staging.jsonc)
  --env-file <path>  Source .env file (default: .env)
  --dry-run          Print matching key names only without uploading
  -h, --help         Show this help message`);
}

function parseEnvFile(filePath) {
	const text = readFileSync(filePath, 'utf8');
	const result = new Map();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim().replace(/^export\s+/, '');
		if (!key) continue;
		let value = trimmed.slice(eqIndex + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		result.set(key, value);
	}
	return result;
}

function parseArgs(argv) {
	const opts = {
		config: 'wrangler.staging.jsonc',
		envFile: '.env',
		dryRun: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			opts.help = true;
		} else if (arg === '--dry-run') {
			opts.dryRun = true;
		} else if (arg === '--config' || arg.startsWith('--config=')) {
			const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
			if (!value) throw new Error('Missing value for --config');
			opts.config = value;
		} else if (arg === '--env-file' || arg.startsWith('--env-file=')) {
			const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
			if (!value) throw new Error('Missing value for --env-file');
			opts.envFile = value;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return opts;
}

function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`Error: ${err.message}`);
		printHelp();
		process.exit(1);
	}

	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	if (!existsSync(opts.envFile)) {
		console.error(`Error: env file not found: ${opts.envFile}`);
		process.exit(1);
	}
	if (!existsSync(opts.config)) {
		console.error(`Error: Wrangler config file not found: ${opts.config}`);
		process.exit(1);
	}

	const envMap = parseEnvFile(opts.envFile);
	const payload = {};
	for (const key of ALLOWED_KEYS) {
		const value = envMap.get(key);
		if (value !== undefined && value !== '') {
			payload[key] = value;
		}
	}

	const keys = Object.keys(payload);
	if (keys.length === 0) {
		console.error(`Error: no allowed keys found in ${opts.envFile}.`);
		process.exit(1);
	}

	if (opts.dryRun) {
		console.log(`Dry run: would upload ${keys.length} secret(s) from ${opts.envFile} to ${opts.config}:`);
		for (const key of keys) {
			console.log(`  - ${key}`);
		}
		process.exit(0);
	}

	console.log(`Uploading ${keys.length} secret(s) (${keys.join(', ')}) via wrangler secret bulk (${opts.config})...`);
	const child = spawn('pnpm', ['exec', 'wrangler', 'secret', 'bulk', '-c', opts.config], {
		stdio: ['pipe', 'inherit', 'inherit'],
	});
	child.on('error', (err) => {
		console.error(`Failed to start wrangler: ${err.message}`);
		process.exit(1);
	});
	child.on('close', (code) => {
		process.exit(code ?? 1);
	});
	child.stdin.end(JSON.stringify(payload));
}

main();
