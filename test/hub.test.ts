import assert from "node:assert/strict";
import test from "node:test";

import {
	type BindAttachmentResult,
	createHubAttachmentInstance,
	createObservableAgentHub,
	type HubAttachment,
	type HubAttachmentInstance,
	type HubTransition,
} from "../src/hub.js";

function hub() {
	return createObservableAgentHub();
}

type ValidBindAttachmentResult = BindAttachmentResult & {
	readonly attachment: HubAttachment;
	readonly error: null;
};

function bind(
	state: ReturnType<typeof hub>,
	sessionId: string,
	hasUI: boolean,
	initialBusy = false,
	instance: HubAttachmentInstance = createHubAttachmentInstance(),
): ValidBindAttachmentResult {
	const result = state.bind({ instance, sessionId, hasUI, initialBusy });
	assert.equal(result.error, null);
	assert.ok(result.attachment);
	return result as ValidBindAttachmentResult;
}

function mainClaim(
	binding: ReturnType<typeof bind>,
): NonNullable<typeof binding.mainClaim> {
	assert.ok(binding.mainClaim, "expected the attachment to own the main claim");
	return binding.mainClaim;
}

function effectKinds(transition: HubTransition): string[] {
	return transition.effects.map((effect) => effect.kind);
}

test("Slice 3 I1: one opaque attachment instance creates one immutable binding and exact repeated binds are inert", () => {
	const state = hub();
	try {
		const rootInstance = createHubAttachmentInstance();
		const first = bind(state, "root", false, false, rootInstance);
		const duplicate = bind(state, "root", false, false, rootInstance);
		const child = bind(state, "child", false);

		assert.equal(first.created, true);
		assert.equal(duplicate.created, false);
		assert.equal(duplicate.inputConflict, false);
		assert.equal(duplicate.attachment, first.attachment);
		assert.notEqual(first.attachment.token, child.attachment.token);
		assert.equal(Object.isFrozen(rootInstance), true);
		assert.equal(Object.isFrozen(first.attachment), true);
		assert.equal(Object.isFrozen(first.attachment.identity), true);
		assert.match(first.attachment.token, /^[0-9a-f-]{36}$/i);
		assert.equal(duplicate.transition.applied, false);
		assert.equal(state.snapshot.attachmentCount, 2);
		assert.equal(state.snapshot.busyCount, 0);
	} finally {
	}
});

test("Slice 3 I1: first bind wins immutable metadata and reports a conflicting repeated bind", () => {
	const state = hub();
	try {
		const instance = createHubAttachmentInstance();
		const first = bind(state, "first-session", false, false, instance);
		const repeated = bind(state, "conflicting-session", true, true, instance);

		assert.equal(repeated.created, false);
		assert.equal(repeated.inputConflict, true);
		assert.equal(repeated.attachment, first.attachment);
		assert.equal(repeated.transition.applied, false);
		assert.deepEqual(state.snapshot.main, {
			sessionId: "first-session",
			hasUI: false,
			generation: mainClaim(first).generation,
		});
		assert.equal(state.snapshot.busyCount, 0);

		assert.equal(state.markBusy(first.attachment).applied, true);
		const afterLifecycleChange = bind(
			state,
			"first-session",
			false,
			false,
			instance,
		);
		assert.equal(afterLifecycleChange.inputConflict, false);
		assert.equal(afterLifecycleChange.transition.applied, false);
	} finally {
	}
});

test("Slice 3 I1: same session attachments keep independent lifecycle state and detach", () => {
	const state = hub();
	try {
		const headlessInstance = createHubAttachmentInstance();
		const uiInstance = createHubAttachmentInstance();
		const headless = bind(
			state,
			"shared-session",
			false,
			false,
			headlessInstance,
		);
		const busyUi = bind(state, "shared-session", true, true, uiInstance);

		assert.equal(headless.created, true);
		assert.equal(busyUi.created, true);
		assert.notEqual(headless.attachment, busyUi.attachment);
		assert.equal(state.snapshot.attachmentCount, 2);
		assert.equal(state.snapshot.busyCount, 1);
		assert.deepEqual(state.snapshot.main, {
			sessionId: "shared-session",
			hasUI: true,
			generation: mainClaim(busyUi).generation,
		});
		assert.equal(state.snapshot.allObservableIdle, false);

		assert.equal(state.markBusy(headless.attachment).applied, true);
		assert.equal(state.markIdle(headless.attachment).applied, true);
		const detachedUi = state.detach(busyUi.attachment);
		assert.equal(detachedUi.snapshot.attachmentCount, 1);
		assert.equal(detachedUi.snapshot.busyCount, 0);
		assert.equal(detachedUi.snapshot.main, null);
		assert.equal(detachedUi.snapshot.allObservableIdle, false);
		assert.equal(state.markIdle(busyUi.attachment).applied, false);
		assert.equal(state.detach(busyUi.attachment).applied, false);
		assert.equal(state.markBusy(headless.attachment).applied, true);
		assert.equal(state.markIdle(headless.attachment).applied, true);

		const reclaimed = state.reclaimMain(headless.attachment);
		assert.equal(reclaimed.applied, true);
		assert.equal(reclaimed.snapshot.main?.sessionId, "shared-session");
		assert.equal(reclaimed.snapshot.main?.hasUI, false);
		assert.equal(reclaimed.snapshot.allObservableIdle, true);
	} finally {
	}
});

test("Scope rules: first headless attachment is the best-effort main and equal-priority bindings cannot steal it", () => {
	const state = hub();
	try {
		const first = bind(state, "headless-1", false);
		const second = bind(state, "headless-2", false);

		const claim = mainClaim(first);
		assert.equal(state.isCurrentMain(claim), true);
		assert.equal(second.mainClaim, null);
		assert.equal(second.transition.applied, true);
		assert.equal(effectKinds(second.transition).includes("mainChanged"), false);
		assert.deepEqual(state.snapshot.main, {
			sessionId: "headless-1",
			hasUI: false,
			generation: claim.generation,
		});
	} finally {
	}
});

test("Scope rules: first UI main wins equal priority while a later UI atomically demotes the headless fallback", () => {
	const state = hub();
	try {
		const headless = bind(state, "headless", false);
		const oldClaim = mainClaim(headless);
		const ui = bind(state, "ui-1", true);
		const uiClaim = mainClaim(ui);
		const equalPriorityUi = bind(state, "ui-2", true);

		assert.equal(state.isCurrentMain(oldClaim), false);
		assert.equal(state.isCurrentMain(uiClaim), true);
		assert.equal(uiClaim.generation > oldClaim.generation, true);
		assert.equal(equalPriorityUi.mainClaim, null);
		assert.equal(effectKinds(ui.transition).includes("mainChanged"), true);
		assert.deepEqual(state.snapshot.main, {
			sessionId: "ui-1",
			hasUI: true,
			generation: uiClaim.generation,
		});
	} finally {
	}
});

test("Scope rules: stale, forged, or detached claims and lifecycle handlers are inert", () => {
	const state = hub();
	try {
		const headless = bind(state, "headless", false);
		const staleClaim = mainClaim(headless);
		const ui = bind(state, "ui", true);
		const currentClaim = mainClaim(ui);

		assert.equal(state.isCurrentMain(staleClaim), false);
		assert.equal(
			state.isCurrentMain({
				token: currentClaim.token,
				generation: currentClaim.generation + 1,
			}),
			false,
		);
		assert.equal(state.markBusy(headless.attachment).applied, true);
		assert.equal(state.detach(headless.attachment).applied, true);
		assert.equal(state.markIdle(headless.attachment).applied, false);
		assert.equal(state.detach(headless.attachment).applied, false);
		assert.equal(state.isCurrentMain(currentClaim), true);
	} finally {
	}
});

test("Examples 5 and 9: all-observable-idle requires a main and every registered attachment to be idle", () => {
	const state = hub();
	try {
		const root = bind(state, "root", true);
		assert.equal(root.transition.snapshot.allObservableIdle, true);

		const busyChild = bind(state, "busy-child", false, true);
		assert.equal(busyChild.transition.snapshot.allObservableIdle, false);
		assert.deepEqual(effectKinds(busyChild.transition), [
			"becameObservableBusy",
		]);
		assert.equal(state.markBusy(busyChild.attachment).applied, false);
		assert.equal(state.snapshot.busyCount, 1);

		const settled = state.markIdle(busyChild.attachment);
		assert.equal(settled.snapshot.allObservableIdle, true);
		assert.deepEqual(effectKinds(settled), ["becameAllObservableIdle"]);
		assert.equal(state.markIdle(busyChild.attachment).applied, false);
	} finally {
	}
});

test("Slice 3: detaching a busy observer recomputes the all-idle transition without negative busy counts", () => {
	const state = hub();
	try {
		bind(state, "root", true);
		const child = bind(state, "child", false, true);
		assert.equal(state.snapshot.busyCount, 1);

		const detached = state.detach(child.attachment);
		assert.equal(detached.snapshot.busyCount, 0);
		assert.equal(detached.snapshot.allObservableIdle, true);
		assert.deepEqual(effectKinds(detached), ["becameAllObservableIdle"]);
		assert.equal(state.detach(child.attachment).applied, false);
		assert.equal(state.snapshot.busyCount, 0);
	} finally {
	}
});

test("Slice 3: releasing main leaves no automatic replacement; the next eligible lifecycle bind elects deterministically", () => {
	const state = hub();
	try {
		const root = bind(state, "ui-root", true);
		const uiChild = bind(state, "ui-child", true);
		const headlessChild = bind(state, "headless-child", false);
		const rootClaim = mainClaim(root);

		const released = state.detach(root.attachment);
		assert.equal(state.isCurrentMain(rootClaim), false);
		assert.equal(released.snapshot.main, null);
		assert.equal(released.snapshot.allObservableIdle, false);
		assert.equal(effectKinds(released).includes("mainChanged"), true);
		assert.equal(state.reclaimMain(headlessChild.attachment).applied, false);

		const reclaimed = state.reclaimMain(uiChild.attachment);
		assert.equal(reclaimed.applied, true);
		assert.equal(reclaimed.snapshot.main?.sessionId, "ui-child");
		assert.equal(reclaimed.snapshot.main?.hasUI, true);
		assert.equal(reclaimed.snapshot.allObservableIdle, true);
		assert.equal(
			reclaimed.snapshot.ownershipGeneration > rootClaim.generation,
			true,
		);

		state.detach(uiChild.attachment);
		state.detach(headlessChild.attachment);
		const releasedHeadless = bind(state, "headless-root", false);
		state.detach(releasedHeadless.attachment);
		const nextEligible = bind(state, "later-headless", false);
		assert.ok(nextEligible.mainClaim);
		assert.equal(
			nextEligible.transition.snapshot.main?.sessionId,
			"later-headless",
		);
	} finally {
	}
});

test("Slice 3: snapshots and transitions are frozen generation/revision checkpoints for later timer wiring", () => {
	const state = hub();
	try {
		const root = bind(state, "root", false);
		const initialRevision = root.transition.snapshot.revision;
		const child = bind(state, "child", false, true);
		const busyRevision = child.transition.snapshot.revision;
		const idle = state.markIdle(child.attachment);

		assert.equal(busyRevision > initialRevision, true);
		assert.equal(idle.snapshot.revision > busyRevision, true);
		assert.equal(Object.isFrozen(idle), true);
		assert.equal(Object.isFrozen(idle.snapshot), true);
		assert.equal(Object.isFrozen(idle.effects), true);
		assert.equal(Object.isFrozen(idle.effects[0]), true);
		assert.throws(() => {
			(idle.snapshot as unknown as { revision: number }).revision = 999;
		}, TypeError);
	} finally {
	}
});

test("Slice 3: isolated factory returns one hub reference", () => {
	const first = createObservableAgentHub();
	const second = first;
	assert.equal(first, second);
	bind(first, "singleton-root", true);
	assert.equal(second.snapshot.main?.sessionId, "singleton-root");
});
