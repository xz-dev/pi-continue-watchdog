import assert from "node:assert/strict";
import test from "node:test";

import {
	createHubAttachmentInstance,
	createObservableAgentHub,
	type HubTransition,
	type ObservableAgentHub,
} from "../src/hub.js";

function hub(): ObservableAgentHub {
	return createObservableAgentHub();
}

function bind(
	state: ObservableAgentHub,
	sessionId: string,
	hasUI: boolean,
	initialBusy = false,
	instance = createHubAttachmentInstance(),
) {
	return state.bind({ instance, sessionId, hasUI, initialBusy });
}

function mainClaim(binding: ReturnType<typeof bind>) {
	assert.ok(binding.mainClaim, "expected the attachment to own the main claim");
	return binding.mainClaim;
}

function effectKinds(transition: HubTransition): string[] {
	return transition.effects.map((effect) => effect.kind);
}

test("duplicate bind is idempotent; distinct instances stay independent even with the same sessionId", () => {
	const state = hub();
	const rootInstance = createHubAttachmentInstance();
	const first = bind(state, "shared", false, false, rootInstance);
	const duplicate = bind(state, "shared", false, false, rootInstance);
	const sameSession = bind(state, "shared", true, true);

	assert.equal(first.created, true);
	assert.equal(duplicate.created, false);
	assert.equal(duplicate.attachment, first.attachment);
	assert.equal(duplicate.transition.applied, false);
	assert.notEqual(first.attachment, sameSession.attachment);
	assert.notEqual(first.attachment.id, sameSession.attachment.id);
	assert.equal(state.snapshot.attachmentCount, 2);
	assert.equal(state.snapshot.busyCount, 1);
	assert.deepEqual(state.snapshot.main, {
		sessionId: "shared",
		hasUI: true,
		generation: mainClaim(sameSession).generation,
	});
});

test("UI-first election: first headless is best-effort main; later UI demotes; equal priority never steals", () => {
	const state = hub();
	const headless = bind(state, "headless", false);
	const oldClaim = mainClaim(headless);
	const secondHeadless = bind(state, "headless-2", false);
	const ui = bind(state, "ui-1", true);
	const uiClaim = mainClaim(ui);
	const equalUi = bind(state, "ui-2", true);

	assert.equal(secondHeadless.mainClaim, null);
	assert.equal(
		effectKinds(secondHeadless.transition).includes("mainChanged"),
		false,
	);
	assert.equal(state.isCurrentMain(oldClaim), false);
	assert.equal(state.isCurrentMain(uiClaim), true);
	assert.equal(uiClaim.generation > oldClaim.generation, true);
	assert.equal(equalUi.mainClaim, null);
	assert.deepEqual(state.snapshot.main, {
		sessionId: "ui-1",
		hasUI: true,
		generation: uiClaim.generation,
	});
});

test("releasing main never auto-promotes; reclaimMain elects only the deterministic preferred candidate", () => {
	const state = hub();
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
	const later = bind(state, "later-headless", false);
	assert.ok(later.mainClaim);
	assert.equal(later.transition.snapshot.main?.sessionId, "later-headless");
});

test("all-observable-idle requires a main and zero busy attachments; detach of busy recomputes", () => {
	const state = hub();
	const root = bind(state, "root", true);
	assert.equal(root.transition.snapshot.allObservableIdle, true);

	const busyChild = bind(state, "busy-child", false, true);
	assert.equal(busyChild.transition.snapshot.allObservableIdle, false);
	assert.deepEqual(effectKinds(busyChild.transition), ["becameObservableBusy"]);
	assert.equal(state.markBusy(busyChild.attachment).applied, true);
	assert.equal(state.snapshot.busyCount, 1);

	const settled = state.markIdle(busyChild.attachment);
	assert.equal(settled.snapshot.allObservableIdle, true);
	assert.deepEqual(effectKinds(settled), ["becameAllObservableIdle"]);
	assert.equal(state.markIdle(busyChild.attachment).applied, true);

	const busyAgain = bind(state, "busy-again", false, true);
	assert.equal(state.snapshot.busyCount, 1);
	const detached = state.detach(busyAgain.attachment);
	assert.equal(detached.snapshot.busyCount, 0);
	assert.equal(detached.snapshot.allObservableIdle, true);
	assert.deepEqual(effectKinds(detached), ["becameAllObservableIdle"]);
});

test("stale claims and lifecycle ops on detached attachments are inert", () => {
	const state = hub();
	const headlessInstance = createHubAttachmentInstance();
	const headless = bind(state, "headless", false, false, headlessInstance);
	const staleClaim = mainClaim(headless);
	const ui = bind(state, "ui", true);
	const currentClaim = mainClaim(ui);

	assert.equal(state.isCurrentMain(staleClaim), false);
	assert.equal(
		state.isCurrentMain({
			attachmentId: currentClaim.attachmentId,
			generation: currentClaim.generation + 1,
		}),
		false,
	);
	assert.equal(state.markBusy(headless.attachment).applied, true);
	assert.equal(state.detach(headless.attachment).applied, true);
	assert.equal(state.markIdle(headless.attachment).applied, false);
	assert.equal(state.detach(headless.attachment).applied, false);
	assert.equal(state.isCurrentMain(currentClaim), true);

	// Tombstoned instance cannot resurrect after detach.
	const resurrect = bind(state, "headless", false, false, headlessInstance);
	assert.equal(resurrect.created, false);
	assert.equal(resurrect.attachment, headless.attachment);
	assert.equal(resurrect.transition.applied, false);
	assert.equal(state.markBusy(headless.attachment).applied, false);
});

test("subscribe fans out applied transitions; unsubscribe is idempotent; one bad listener is isolated", () => {
	const state = hub();
	const seenA: string[] = [];
	const seenB: string[] = [];
	let throwCount = 0;

	const unsubscribeA = state.subscribe((transition) => {
		seenA.push(...effectKinds(transition));
	});
	const unsubscribeThrowing = state.subscribe(() => {
		throwCount += 1;
		throw new Error("listener boom");
	});
	const unsubscribeB = state.subscribe((transition) => {
		seenB.push(...effectKinds(transition));
	});

	const root = bind(state, "root", true);
	assert.deepEqual(effectKinds(root.transition), [
		"mainChanged",
		"becameAllObservableIdle",
	]);
	assert.deepEqual(seenA, ["mainChanged", "becameAllObservableIdle"]);
	assert.deepEqual(seenB, ["mainChanged", "becameAllObservableIdle"]);
	assert.equal(throwCount, 1);

	// Equal live observations are applied and notify, but add no edge effect.
	const before = seenA.length;
	assert.equal(state.markIdle(root.attachment).applied, true);
	assert.equal(seenA.length, before);
	assert.equal(throwCount, 2);

	const child = bind(state, "child", false, true);
	assert.deepEqual(effectKinds(child.transition), ["becameObservableBusy"]);
	assert.deepEqual(seenA, [
		"mainChanged",
		"becameAllObservableIdle",
		"becameObservableBusy",
	]);
	assert.deepEqual(seenB, [
		"mainChanged",
		"becameAllObservableIdle",
		"becameObservableBusy",
	]);
	assert.equal(throwCount, 3);

	unsubscribeA();
	unsubscribeA();
	unsubscribeThrowing();
	state.markIdle(child.attachment);
	assert.deepEqual(seenA, [
		"mainChanged",
		"becameAllObservableIdle",
		"becameObservableBusy",
	]);
	assert.deepEqual(seenB, [
		"mainChanged",
		"becameAllObservableIdle",
		"becameObservableBusy",
		"becameAllObservableIdle",
	]);

	// Detach subscribers observe committed post-detach state.
	const detachSeen: ObservableAgentHub["snapshot"][] = [];
	state.subscribe((transition) => {
		detachSeen.push(transition.snapshot);
	});
	const detached = state.detach(root.attachment);
	assert.equal(detached.snapshot.main, null);
	assert.equal(detachSeen.at(-1)?.main, null);
	assert.equal(detachSeen.at(-1)?.attachmentCount, 1);
	unsubscribeB();
});

test("isolated factory hubs do not share state", () => {
	const first = createObservableAgentHub();
	const second = createObservableAgentHub();
	bind(first, "a", true);
	bind(second, "b", false);
	assert.equal(first.snapshot.main?.sessionId, "a");
	assert.equal(second.snapshot.main?.sessionId, "b");
	assert.notEqual(first, second);
});

test("snapshot objects are fresh structural copies, not shared mutable internals", () => {
	const state = hub();
	const first = bind(state, "root", false);
	const snapA = first.transition.snapshot;
	const snapB = state.snapshot;
	assert.notEqual(snapA, snapB);
	assert.deepEqual(snapA, snapB);

	(snapB as { revision: number }).revision = 999;
	assert.equal(state.snapshot.revision, snapA.revision);
	assert.notEqual(state.snapshot.revision, 999);

	const child = bind(state, "child", false, true);
	assert.equal(child.transition.snapshot.revision > snapA.revision, true);
	assert.equal(state.snapshot.revision, child.transition.snapshot.revision);
});
