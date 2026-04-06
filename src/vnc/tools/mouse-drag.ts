import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BUTTON_MASK } from '../protocol/protocol-types.js';
import type { SessionManager } from '../protocol/session-manager.js';

interface Point {
	x: number;
	y: number;
}

export interface MouseDragArgs {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	button?: 'left' | 'middle' | 'right';
	steps?: number;
	delay_ms?: number;
	controlPoints?: Point[];
	session_id?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function bezierPoint(t: number, start: Point, end: Point, controlPoints: Point[]): Point {
	const n = controlPoints.length;

	if (n === 0) {
		// Linear
		return { x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t) };
	}

	if (n === 1) {
		// Quadratic: (1-t)^2*P0 + 2*(1-t)*t*C + t^2*P1
		const c = controlPoints[0];
		const mt = 1 - t;
		return {
			x: mt * mt * start.x + 2 * mt * t * c.x + t * t * end.x,
			y: mt * mt * start.y + 2 * mt * t * c.y + t * t * end.y,
		};
	}

	if (n === 2) {
		// Cubic: (1-t)^3*P0 + 3*(1-t)^2*t*C1 + 3*(1-t)*t^2*C2 + t^3*P1
		const c1 = controlPoints[0];
		const c2 = controlPoints[1];
		const mt = 1 - t;
		return {
			x:
				mt * mt * mt * start.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * end.x,
			y:
				mt * mt * mt * start.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * end.y,
		};
	}

	// 3+ control points: De Casteljau's algorithm on [start, ...controlPoints, end]
	const points = [start, ...controlPoints, end];
	let current = points;
	for (let level = current.length - 1; level > 0; level--) {
		const next: Point[] = [];
		for (let i = 0; i < level; i++) {
			next.push({
				x: lerp(current[i].x, current[i + 1].x, t),
				y: lerp(current[i].y, current[i + 1].y, t),
			});
		}
		current = next;
	}
	return current[0];
}

export async function handleMouseDrag(
	args: MouseDragArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const client = sessionManager.getSession(args.session_id);
	const mask = BUTTON_MASK[args.button ?? 'left'];
	const steps = args.steps ?? 10;
	const delay = args.delay_ms ?? 5;
	const cp = args.controlPoints ?? [];
	const start: Point = { x: args.startX, y: args.startY };
	const end: Point = { x: args.endX, y: args.endY };

	// Move to start position
	client.sendPointer(start.x, start.y, 0);

	// Press button
	client.sendPointer(start.x, start.y, mask);

	// Interpolate along path
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const p = bezierPoint(t, start, end, cp);
		client.sendPointer(Math.round(p.x), Math.round(p.y), mask);
		if (delay > 0) await sleep(delay);
	}

	// Release button
	client.sendPointer(end.x, end.y, 0);

	const pathType =
		cp.length === 0 ? 'linear' : cp.length === 1 ? 'quadratic bezier' : 'cubic bezier';
	return {
		content: [
			{
				type: 'text',
				text: `Dragged ${args.button ?? 'left'} button from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) via ${pathType} path`,
			},
		],
	};
}
