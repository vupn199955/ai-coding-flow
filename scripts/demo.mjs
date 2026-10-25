const port = process.env.FLOW_API_PORT || '4310';
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: true }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  console.log(
    `Demo started: ${result.id}\nOpen http://127.0.0.1:${process.env.FLOW_WEB_PORT || '3000'} to follow it.`,
  );
} catch (error) {
  console.error(`Could not start demo: ${error.message}\nStart AI Flow with npm run dev first.`);
  process.exitCode = 1;
}
import './environment.mjs';
