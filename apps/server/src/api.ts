import 'reflect-metadata';
import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Inject,
  Res,
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response, Request } from 'express';
import { z } from 'zod';
import type { FlowEvent } from '@ai-flow/shared';
import { FlowController } from './orchestrator';
import { Store } from './store';
import { renderReview } from './review';
import { runProcess } from './process';
import { listDirectories } from './projects';

const createPlanSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    projectId: z.string().min(1).optional(),
    repositoryPath: z.string().min(1).optional(),
    taskPath: z.string().min(1).optional(),
    taskIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict();

@Catch()
class ApiErrors implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 400;
    const message =
      exception instanceof z.ZodError
        ? exception.issues
            .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
            .join('; ')
        : exception instanceof Error
          ? exception.message
          : 'Request failed.';
    response.status(status).json({ error: message });
  }
}

@Controller('api')
class ApiController {
  constructor(@Inject('FLOW') private readonly flow: FlowController) {}

  @Get('health') health() {
    return { status: 'ok', name: 'AI Flow', version: '0.1.0' };
  }
  @Get('state') state() {
    return this.flow.state();
  }
  @Get('config') config() {
    return this.flow.config();
  }
  @Put('config') updateConfig(@Body() body: unknown) {
    return this.flow.updateConfig(body);
  }
  @Post('runtime/refresh') runtime(@Query('projectId') projectId?: string) {
    return this.flow.refreshRuntime(projectId);
  }
  @Get('directories') directories(@Query('path') directory?: string) {
    return listDirectories(directory);
  }
  @Get('projects') projects() {
    return this.flow.store.listProjects();
  }
  @Post('projects') createProject(@Body() body: unknown) {
    return this.flow.createProject(
      z
        .object({
          repositoryPath: z.string().min(1),
          name: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .parse(body),
    );
  }
  @Put('projects/:id') updateProject(@Param('id') id: string, @Body() body: unknown) {
    return this.flow.updateProject(
      id,
      z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          config: z.unknown().optional(),
        })
        .strict()
        .parse(body),
    );
  }
  @Get('tasks') tasks(@Query('path') taskPath?: string) {
    return this.flow.previewTasks(taskPath);
  }
  @Get('plans/:id') plan(@Param('id') id: string) {
    return this.flow.requirePlan(id);
  }
  @Post('plans') create(@Body() body: unknown) {
    return this.flow.createPlan(createPlanSchema.parse(body));
  }
  @Delete('plans/:id') remove(@Param('id') id: string) {
    return this.flow.removePlan(id);
  }
  @Post('plans/:id/start') start(@Param('id') id: string) {
    return this.flow.start(id);
  }
  @Post('plans/:id/pause') pause(@Param('id') id: string) {
    return this.flow.stop(id, 'pause');
  }
  @Post('plans/:id/cancel') cancel(@Param('id') id: string) {
    return this.flow.stop(id, 'cancel');
  }
  @Patch('plans/:id/limits') limits(@Param('id') id: string, @Body() body: unknown) {
    return this.flow.updateLimits(id, body);
  }

  @Post('demo') async demo(@Body() body: unknown) {
    const input = z.object({ start: z.boolean().optional() }).parse(body || {});
    const plan = await this.flow.createDemo();
    return input.start ? this.flow.start(plan.id) : plan;
  }

  @Get('events') events(@Query('planId') planId?: string, @Query('after') after?: string) {
    return this.flow.store.getEvents(planId, Number(after) || 0, 1500);
  }

  @Get('stream') stream(@Res() response: Response) {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write('event: connected\ndata: {}\n\n');
    const listener = (event: FlowEvent) => {
      if (!response.writableEnded)
        response.write(`id: ${event.id}\nevent: flow\ndata: ${JSON.stringify(event)}\n\n`);
    };
    this.flow.store.events.on('event', listener);
    const shutdown = () => response.end();
    this.flow.store.events.once('shutdown', shutdown);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': heartbeat\n\n');
    }, 15_000);
    response.on('close', () => {
      clearInterval(heartbeat);
      this.flow.store.events.off('event', listener);
      this.flow.store.events.off('shutdown', shutdown);
    });
  }

  @Get('plans/:id/reviews/:reviewId') report(
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Res() response: Response,
  ) {
    const plan = this.flow.requirePlan(id);
    const review = [
      ...plan.tasks.flatMap((task) => task.reviews),
      ...(plan.finalReview ? [plan.finalReview] : []),
    ].find((item) => item.id === reviewId);
    if (!review) throw new Error('Review report not found.');
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="review-${review.taskId}-round-${review.round}.md"`,
    );
    response.send(renderReview(review));
  }

  @Get('plans/:id/diff') async diff(@Param('id') id: string, @Query('taskId') taskId?: string) {
    const plan = this.flow.requirePlan(id);
    const task = taskId ? plan.tasks.find((item) => item.id === taskId) : undefined;
    if (taskId && !task) throw new Error('Task not found.');
    const cwd = task?.workspacePath || plan.workspacePath;
    const base = task?.baseCommit || plan.baseCommit;
    const candidate = task?.candidateCommit || plan.finalCommit;
    if (!cwd || !base || !candidate)
      return { diff: '', message: 'A candidate snapshot is not available yet.' };
    const result = await runProcess(
      'git',
      ['diff', '--no-ext-diff', '--no-color', base, candidate],
      { cwd, timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Could not read diff.');
    return { diff: result.stdout, truncated: result.stdout.length >= 256_000 };
  }
}

export async function createApp(options: { root: string; dataDirectory: string; logger?: false }) {
  const store = new Store(options.dataDirectory);
  const flow = new FlowController(store, options.root);
  @Module({ controllers: [ApiController], providers: [{ provide: 'FLOW', useValue: flow }] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, {
    logger: options.logger === false ? false : ['error', 'warn', 'log'],
  });
  app.useGlobalFilters(new ApiErrors());
  app.use((request: Request, response: Response, next: () => void) => {
    const origin = request.headers.origin;
    if (origin) {
      const allowed = new Set([
        `http://127.0.0.1:${process.env.FLOW_WEB_PORT || '3000'}`,
        `http://localhost:${process.env.FLOW_WEB_PORT || '3000'}`,
        `http://127.0.0.1:${process.env.FLOW_API_PORT || '4310'}`,
        `http://localhost:${process.env.FLOW_API_PORT || '4310'}`,
      ]);
      if (!allowed.has(origin)) {
        response
          .status(403)
          .json({ error: 'Only the local AI Flow dashboard can access this controller.' });
        return;
      }
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  return { app, flow, store };
}
