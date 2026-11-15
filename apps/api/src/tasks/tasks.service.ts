import type { Prisma } from "@atrium/database";
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ActivityService } from "../activity/activity.service";
import { paginationArgs, paginatedResponse } from "../common";
import {
  CreateTaskDto,
  CreateClientTaskDto,
  UpdateTaskDto,
  SubmitTaskWorkDto,
  VerifyTaskWorkDto,
  ClientReviewTaskDto,
} from "./tasks.dto";

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private activityService: ActivityService,
    @InjectPinoLogger(TasksService.name) private readonly logger: PinoLogger,
  ) {}

  async create(dto: CreateTaskDto, projectId: string, orgId: string, requestedById?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
    });
    if (!project) throw new NotFoundException("Project not found");

    const maxOrder = await this.prisma.task.aggregate({
      where: { projectId, organizationId: orgId },
      _max: { order: true },
    });
    const order = (maxOrder._max.order ?? -1) + 1;

    const isDecision = dto.type === "decision";

    if (isDecision) {
      if (!dto.question) throw new BadRequestException("Question is required for decision tasks");
      if (!dto.options || dto.options.length < 2) {
        throw new BadRequestException("Decision tasks require at least 2 options");
      }
    }

    const task = await this.prisma.task.create({
      data: {
        title: dto.title,
        description: dto.description,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        status: "open",
        requestedById: requestedById ?? null,
        order,
        type: isDecision ? "decision" : "checkbox",
        question: isDecision ? dto.question : undefined,
        projectId,
        organizationId: orgId,
        ...(isDecision && dto.options
          ? {
              options: {
                create: dto.options.map((opt, idx) => ({
                  label: opt.label,
                  order: idx,
                })),
              },
            }
          : {}),
      },
      include: {
        options: isDecision ? { orderBy: { order: "asc" as const } } : false,
      },
    });

    this.notifications.notifyTaskCreated(
      projectId,
      dto.title,
      dto.dueDate ? new Date(dto.dueDate) : undefined,
    );

    return task;
  }

  /**
   * Create a task on behalf of a portal client.
   * Validates that the caller is assigned to the project.
   * Only checkbox tasks allowed.
   */
  async createForClient(
    dto: CreateClientTaskDto,
    projectId: string,
    userId: string,
    orgId: string,
  ) {
    const assignment = await this.prisma.projectClient.findFirst({
      where: { projectId, userId, project: { organizationId: orgId } },
      include: { user: { select: { name: true } } },
    });
    if (!assignment) throw new ForbiddenException("Not assigned to this project");

    const maxOrder = await this.prisma.task.aggregate({
      where: { projectId, organizationId: orgId },
      _max: { order: true },
    });
    const order = (maxOrder._max.order ?? -1) + 1;

    const task = await this.prisma.task.create({
      data: {
        title: dto.title,
        description: dto.description,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        status: "open",
        requestedById: userId,
        order,
        type: "checkbox",
        projectId,
        organizationId: orgId,
      },
    });

    this.notifications.notifyClientRequestCreated(
      projectId,
      orgId,
      dto.title,
      assignment.user.name,
    );

    return task;
  }

  async findByProject(
    projectId: string,
    orgId: string,
    page = 1,
    limit = 20,
    status?: string,
  ): Promise<any> {
    const statusFilter =
      status === "active"
        ? {
            status: {
              in: [
                "open",
                "in_progress",
                "submitted_for_verification",
                "in_client_review",
                "revision_requested",
              ],
            },
          }
        : status && status !== "all"
        ? { status }
        : {};
    // Internal tasks (from before a potential contract was won) show in the Internal tab only.
    const where = { projectId, organizationId: orgId, internal: false, ...statusFilter };
    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: {
          options: {
            orderBy: { order: "asc" },
            include: {
              _count: { select: { votes: true } },
            },
          },
          labels: { include: { label: true } },
          requester: { select: { id: true, name: true, image: true } },
          assignee: { select: { id: true, name: true, image: true } },
          submissions: {
            include: {
              submittedBy: { select: { id: true, name: true, image: true } },
            },
            orderBy: { createdAt: "desc" },
          },
          revisions: {
            orderBy: { createdAt: "desc" },
          },
          _count: { select: { votes: true, comments: true } },
        },
        orderBy: { order: "asc" },
        ...paginationArgs(page, limit),
      }),
      this.prisma.task.count({ where }),
    ]);

    // Only look up memberships for requesters actually present on this page
    const requesterIds = Array.from(
      new Set(data.map((t) => t.requestedById).filter((id): id is string => !!id)),
    );
    const members = requesterIds.length
      ? await this.prisma.member.findMany({
          where: { organizationId: orgId, userId: { in: requesterIds } },
          select: { userId: true },
        })
      : [];
    const memberUserIds = new Set(members.map((m) => m.userId));

    const enriched = data.map((task) => ({
      ...task,
      isClientRequest: task.requestedById ? !memberUserIds.has(task.requestedById) : false,
    }));

    return paginatedResponse(enriched, total, page, limit);
  }

  async findByProjectForClient(
    projectId: string,
    userId: string,
    orgId: string,
    page = 1,
    limit = 20,
    isPrivileged = false,
  ): Promise<any> {
    if (!isPrivileged) {
      const assignment = await this.prisma.projectClient.findFirst({
        where: { projectId, userId, project: { organizationId: orgId } },
      });
      if (!assignment) {
        throw new ForbiddenException("Not assigned to this project");
      }
    }

    const where = { projectId, organizationId: orgId, internal: false };
    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: {
          options: {
            orderBy: { order: "asc" },
            include: {
              _count: { select: { votes: true } },
            },
          },
          votes: {
            where: { userId },
            select: { optionId: true },
          },
          labels: { include: { label: true } },
          requester: { select: { id: true, name: true, image: true } },
          assignee: { select: { id: true, name: true, image: true } },
          submissions: {
            where: { isVerified: true },
            include: {
              submittedBy: { select: { id: true, name: true, image: true } },
            },
            orderBy: { createdAt: "desc" },
          },
          revisions: {
            orderBy: { createdAt: "desc" },
          },
          _count: { select: { votes: true, comments: { where: { internal: false } } } },
        },
        orderBy: { order: "asc" },
        ...paginationArgs(page, limit),
      }),
      this.prisma.task.count({ where }),
    ]);

    const clientCount = await this.prisma.projectClient.count({ where: { projectId } });

    const sanitized = data.map((task) => {
      if (task.type === "decision" && !task.closedAt && task.options) {
        const allVoted = task._count.votes >= clientCount;
        if (!allVoted) {
          return {
            ...task,
            options: task.options.map((opt) => ({
              ...opt,
              _count: { votes: 0 },
            })),
            _count: { votes: 0, comments: task._count.comments },
          };
        }
      }
      return task;
    });

    return paginatedResponse(sanitized, total, page, limit);
  }

  async exportByProject(projectId: string, orgId: string) {
    return this.prisma.task.findMany({
      where: { projectId, organizationId: orgId, internal: false },
      orderBy: { order: "asc" },
    });
  }

  async vote(taskId: string, optionId: string, userId: string, orgId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, type: "decision", internal: false },
      include: { options: true },
    });
    if (!task) throw new NotFoundException("Decision task not found");
    if (task.closedAt) throw new BadRequestException("Voting is closed");

    const assignment = await this.prisma.projectClient.findFirst({
      where: { projectId: task.projectId, userId },
    });
    if (!assignment) {
      throw new ForbiddenException("Not assigned to this project");
    }

    const option = task.options.find((o) => o.id === optionId);
    if (!option) throw new BadRequestException("Invalid option");

    const vote = await this.prisma.decisionVote.upsert({
      where: { taskId_userId: { taskId, userId } },
      create: { optionId, taskId, userId },
      update: { optionId },
    });

    this.activityService
      .create({
        type: "decision_vote",
        action: "voted",
        actorId: userId,
        targetId: taskId,
        targetTitle: task.question || task.title,
        detail: option.label,
        projectId: task.projectId,
        organizationId: orgId,
      })
      .catch((err) => this.logger.warn({ err }, "Failed to log decision vote activity"));

    return vote;
  }

  async closeVoting(taskId: string, orgId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, type: "decision" },
    });
    if (!task) throw new NotFoundException("Decision task not found");
    if (task.closedAt) throw new BadRequestException("Voting is already closed");
    if (task.status === "cancelled") throw new BadRequestException("Cannot close voting on a cancelled task");

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { closedAt: new Date(), status: "done" },
      include: {
        options: {
          orderBy: { order: "asc" },
          include: {
            _count: { select: { votes: true } },
          },
        },
      },
    });

    // Internal tasks are hidden from clients, so they aren't told about them.
    if (!task.internal) this.notifications.notifyDecisionClosed(taskId);

    this.activityService
      .create({
        type: "decision_closed",
        action: "closed",
        actorId: "system",
        targetId: taskId,
        targetTitle: task.question || task.title,
        projectId: task.projectId,
        organizationId: orgId,
        internal: task.internal,
      })
      .catch((err) => this.logger.warn({ err }, "Failed to log decision closed activity"));

    return updated;
  }

  async update(
    id: string,
    dto: UpdateTaskDto,
    orgId: string,
    actorUserId?: string,
    actorRole?: string,
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!task) throw new NotFoundException("Task not found");

    // Developers can update tasks assigned to them or unassigned tasks in the project
    if (actorRole === "developer" && task.assigneeId && task.assigneeId !== actorUserId) {
      // Allow developer to view or participate, but restrict reassignment
      if (dto.assigneeId !== undefined && dto.assigneeId !== task.assigneeId) {
        throw new ForbiddenException("Developers cannot reassign tasks");
      }
    }

    // assigneeId: null = unassign, non-empty string = assign, empty string = reject
    if (dto.assigneeId === "") {
      throw new BadRequestException("assigneeId cannot be empty");
    }
    if (dto.assigneeId) {
      const member = await this.prisma.member.findFirst({
        where: {
          userId: dto.assigneeId,
          organizationId: orgId,
          role: { in: ["owner", "admin", "developer"] },
        },
      });
      if (!member) throw new BadRequestException("Assignee must be an agency staff member (owner, admin, or developer)");
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        dueDate: dto.dueDate !== undefined ? (dto.dueDate ? new Date(dto.dueDate) : null) : undefined,
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
      },
    });

    if (dto.status && dto.status !== task.status && !task.internal) {
      this.notifications.notifyTaskStatusChanged(
        task.id,
        task.title,
        task.projectId,
        orgId,
        dto.status,
        task.requestedById,
        updated.assigneeId,
      );
    }

    if (dto.assigneeId && dto.assigneeId !== task.assigneeId) {
      this.notifications.notifyTaskAssigned(
        task.title,
        task.projectId,
        orgId,
        dto.assigneeId,
      );
    }

    return updated;
  }

  /**
   * Developer submits screenshots, demo links, and progress notes for QA verification.
   */
  async submitWork(
    taskId: string,
    dto: SubmitTaskWorkDto,
    userId: string,
    orgId: string,
  ): Promise<any> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId },
      include: { project: { select: { id: true, name: true } } },
    });
    if (!task) throw new NotFoundException("Task not found");

    const submission = await this.prisma.taskSubmission.create({
      data: {
        taskId,
        submittedById: userId,
        notes: dto.notes?.trim() || null,
        previewUrl: dto.previewUrl?.trim() || null,
        attachments: (dto.attachments as unknown as Prisma.InputJsonValue) ?? [],
      },
      include: {
        submittedBy: { select: { id: true, name: true, image: true } },
      },
    });

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: "submitted_for_verification",
        verificationStatus: "pending_admin",
      },
      include: {
        submissions: {
          include: { submittedBy: { select: { id: true, name: true, image: true } } },
          orderBy: { createdAt: "desc" },
        },
        revisions: { orderBy: { createdAt: "desc" } },
      },
    });

    this.notifications.notifyTaskStatusChanged(
      task.id,
      task.title,
      task.projectId,
      orgId,
      "submitted_for_verification",
      task.requestedById,
      task.assigneeId,
    );

    return { task: updatedTask, submission };
  }

  /**
   * Admin verifies developer's submitted work before exposing to the client.
   */
  async verifyWork(
    taskId: string,
    dto: VerifyTaskWorkDto,
    adminUserId: string,
    orgId: string,
  ): Promise<any> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId },
    });
    if (!task) throw new NotFoundException("Task not found");

    const latestSubmission = await this.prisma.taskSubmission.findFirst({
      where: { taskId },
      orderBy: { createdAt: "desc" },
    });

    if (latestSubmission) {
      await this.prisma.taskSubmission.update({
        where: { id: latestSubmission.id },
        data: {
          isVerified: dto.approved,
          verifiedAt: new Date(),
          verifiedById: adminUserId,
          adminFeedback: dto.feedback?.trim() || null,
        },
      });
    }

    const nextStatus = dto.approved ? "in_client_review" : "in_progress";
    const verificationStatus = dto.approved ? "verified" : "rejected";
    const clientReviewStatus = dto.approved ? "pending_client" : "none";

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: nextStatus,
        verificationStatus,
        clientReviewStatus,
      },
      include: {
        submissions: {
          include: { submittedBy: { select: { id: true, name: true, image: true } } },
          orderBy: { createdAt: "desc" },
        },
        revisions: { orderBy: { createdAt: "desc" } },
      },
    });

    this.notifications.notifyTaskStatusChanged(
      task.id,
      task.title,
      task.projectId,
      orgId,
      nextStatus,
      task.requestedById,
      task.assigneeId,
    );

    return updatedTask;
  }

  /**
   * Client reviews verified work in portal: approves or requests changes.
   */
  async clientReview(
    taskId: string,
    dto: ClientReviewTaskDto,
    userId: string,
    orgId: string,
  ): Promise<any> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, internal: false },
    });
    if (!task) throw new NotFoundException("Task not found");

    const assignment = await this.prisma.projectClient.findFirst({
      where: { projectId: task.projectId, userId },
    });
    if (!assignment) {
      throw new ForbiddenException("Not assigned to this project");
    }

    if (dto.action === "approve") {
      const updatedTask = await this.prisma.task.update({
        where: { id: taskId },
        data: {
          status: "done",
          clientReviewStatus: "approved",
          closedAt: new Date(),
        },
        include: {
          submissions: {
            where: { isVerified: true },
            include: { submittedBy: { select: { id: true, name: true, image: true } } },
            orderBy: { createdAt: "desc" },
          },
          revisions: { orderBy: { createdAt: "desc" } },
        },
      });

      this.notifications.notifyTaskStatusChanged(
        task.id,
        task.title,
        task.projectId,
        orgId,
        "done",
        task.requestedById,
        task.assigneeId,
      );

      return updatedTask;
    } else {
      const nextRevNumber = (task.revisionCount ?? 0) + 1;
      await this.prisma.taskRevision.create({
        data: {
          taskId,
          revisionNumber: nextRevNumber,
          clientFeedback: dto.feedback?.trim() || "Changes requested by client",
          assignedToId: task.assigneeId,
          status: "open",
        },
      });

      const updatedTask = await this.prisma.task.update({
        where: { id: taskId },
        data: {
          status: "revision_requested",
          clientReviewStatus: "changes_requested",
          revisionCount: nextRevNumber,
        },
        include: {
          submissions: {
            include: { submittedBy: { select: { id: true, name: true, image: true } } },
            orderBy: { createdAt: "desc" },
          },
          revisions: { orderBy: { createdAt: "desc" } },
        },
      });

      this.notifications.notifyTaskStatusChanged(
        task.id,
        task.title,
        task.projectId,
        orgId,
        "revision_requested",
        task.requestedById,
        task.assigneeId,
      );

      return updatedTask;
    }
  }

  /**
   * Cancel a task that the client originally requested.
   * Only the requesting user can cancel their own open tasks.
   */
  async cancelClientTask(taskId: string, userId: string, orgId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, internal: false },
    });
    if (!task) throw new NotFoundException("Task not found");
    if (task.requestedById !== userId) throw new ForbiddenException("Cannot cancel this task");
    if (task.type !== "checkbox") throw new BadRequestException("Only checkbox tasks can be cancelled");
    if (task.status !== "open") throw new BadRequestException("Only open tasks can be cancelled");

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: "cancelled" },
    });

    this.notifications.notifyTaskStatusChanged(
      task.id,
      task.title,
      task.projectId,
      orgId,
      "cancelled",
      task.requestedById,
      task.assigneeId,
    );

    return updated;
  }

  async reorder(taskIds: string[], orgId: string) {
    const updates = taskIds.map((id, index) =>
      this.prisma.task.updateMany({
        where: { id, organizationId: orgId },
        data: { order: index },
      }),
    );
    await this.prisma.$transaction(updates);
  }

  async remove(id: string, orgId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!task) throw new NotFoundException("Task not found");

    await this.prisma.task.delete({ where: { id } });
  }
}
