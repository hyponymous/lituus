/**
 * Device probe for AI scoring — `#probe`.
 *
 * `#spike` asks whether the deployed site can reach a GPU. This asks the
 * question that came after it: whether the GPU it reaches computes the right
 * answer. Two phone sessions produced point losses tens of points from the
 * laptop's on the same build — stable, finite, plausible, and wrong — and
 * neither the degenerate-readback guard nor the drift canary could see it,
 * because the device was perfectly consistent with itself.
 *
 * Ships for the same reason the spike does: a diagnostic that only runs where
 * the fault cannot occur is not a diagnostic. This one is meant to be opened on
 * the phone, so it reports numbers a reader can select and paste back rather
 * than a verdict they have to trust.
 *
 * Reachable only by typing the fragment, and dynamically imported, so an
 * ordinary visit pays nothing for it.
 */

import { describeDevice } from './device.ts';
import { NETWORK, networkUrl } from './engine/network.ts';
import type { ProbeReport, ProbeRequest } from './engine/probe-worker.ts';
import { EXPECTED_ON } from './engine/canary-expected.ts';
import { makeReport, type Status, type Step } from './report.ts';

/** What each stage is called on screen, in the order the worker reports them. */
const STAGES: ReadonlyArray<{ readonly stage: ProbeReport['stage']; readonly title: string }> = [
  { stage: 'backend', title: 'WebGPU in a worker' },
  { stage: 'readback', title: 'Known numbers through the GPU' },
  { stage: 'network', title: `Load ${NETWORK.label}` },
  { stage: 'forward', title: 'One forward pass, fixed input' },
  { stage: 'compare', title: 'Against a device known to be right' },
];

/**
 * Run the probe and fill the report in as it answers.
 *
 * Every stage is created up front and left saying "running…" until its report
 * arrives, so a stage that never answers is visible as the one that hung —
 * which on a phone, where the failures are about memory and time, is most of
 * the diagnosis.
 */
export async function renderProbe(root: HTMLElement): Promise<void> {
  const add: (title: string) => Step = makeReport(
    root,
    'Device probe',
    'Whether this device computes the network the way the machine that ' +
      'calibrated it does. Numbers are printed in full so two devices can be ' +
      'compared line by line.',
  );

  const context: Step = add('This device');
  context.note('read');
  context.detail(`device: ${await describeDevice()}`);
  context.detail(`secure context: ${window.isSecureContext}`);
  context.detail(`reference: ${EXPECTED_ON}`);

  const steps = new Map<ProbeReport['stage'], Step>(
    STAGES.map(({ stage, title }) => [stage, add(title)]),
  );

  const worker = new Worker(new URL('./engine/probe-worker.ts', import.meta.url), {
    type: 'module',
  });

  await new Promise<void>((done) => {
    worker.onmessage = (event: MessageEvent<ProbeReport>): void => {
      const report: ProbeReport = event.data;
      if (report.stage === 'failed') {
        // Whichever stage is still running is the one that failed; the message
        // belongs against it rather than at the bottom of the page.
        const pending: Step | undefined = STAGES.map(({ stage }) => steps.get(stage)).find(
          (step: Step | undefined) => step !== undefined,
        );
        pending?.note('failed', 'bad');
        pending?.detail(report.detail);
        done();
        return;
      }
      const step: Step | undefined = steps.get(report.stage);
      const status: Status = report.ok ? 'ok' : 'bad';
      step?.note(report.ok ? 'ok' : 'differs', status);
      step?.detail(report.detail);
      steps.delete(report.stage);
      if (report.stage === 'compare') {
        worker.terminate();
        done();
      }
    };
    worker.onerror = (event: ErrorEvent): void => {
      context.detail(`worker stopped: ${event.message}`);
      done();
    };

    const request: ProbeRequest = { networkUrl: networkUrl() };
    worker.postMessage(request);
  });
}
