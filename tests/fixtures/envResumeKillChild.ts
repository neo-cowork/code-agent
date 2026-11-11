// Run with node --import tsx; caller provides an isolated data directory.
import { harness } from '../unit/host/runtime/envResumeHarness';
import { armEnvResumeOnPark, registerEnvResumeContinuer } from '../../src/host/runtime/envResumeWaiter';
import { DurableRecoveryDispatcher } from '../../src/host/runtime/durableRecoveryDispatcher';

const [mode, workspace, file] = process.argv.slice(2);
if (!workspace || !file) throw new Error('mode, workspace and database are required');
const fixture = await harness(workspace, file);
if (mode === 'park') {
  fixture.wire(async () => 'red');
  await fixture.park();
  process.stdout.write(`READY ${process.pid}\n`);
  setInterval(() => {}, 1_000);
} else {
  let continued = 0;
  registerEnvResumeContinuer(async () => { continued++; return fixture.continueRun(); }, () => async () => 'green');
  const plans = await fixture.registry.recoverDurable(Date.now() + 120_001);
  const dispatcher = new DurableRecoveryDispatcher();
  let recoveredAutomatically = 0;
  dispatcher.registerEngineHandler({ name: 'env-startup-observer', engineKind: 'native', recover: async () => { recoveredAutomatically++; return { status: 'recovered', reason: 'unexpected startup recovery' }; } });
  console.log('STARTUP_DISPATCH', JSON.stringify(await dispatcher.dispatch(plans, Date.now() + 120_001)));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  console.log('STARTUP_PARK', JSON.stringify(await fixture.repository.get('env-run')));
  console.log('STARTUP_AUTO_CONTINUES', continued, 'RECOVERY_HANDLER_CALLS', recoveredAutomatically);
  if (continued || recoveredAutomatically || plans.length !== 1 || !plans[0].resumeBlocked) throw new Error('startup automatically continued');
  fixture.green();
  armEnvResumeOnPark({ runId: 'env-run', sessionId: 'env-session', envBlocked: plans[0].envelope.envBlocked! });
  const deadline = Date.now() + 15_000;
  while ((await fixture.repository.get('env-run'))?.status !== 'completed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const envelope = await fixture.repository.get('env-run');
  console.log('AFTER_GREEN', JSON.stringify(envelope));
  fixture.dump();
  if (envelope?.status !== 'completed' || Number(continued) !== 1) throw new Error('green did not continue same run');
  await dispatcher.shutdown(); fixture.close();
  // Some imported application services own lazy timers; this fixture owns the process.
  process.exit(0);
}
