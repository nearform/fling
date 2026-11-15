/**
 * Lambda Web Functions as the site servers adapter uses them (site-servers.ts): the few control
 * plane calls it makes, and one data plane call, `fetch`, a request to an endpoint signed with
 * SigV4 (service `lambda`, `x-amz-content-sha256: UNSIGNED-PAYLOAD`) under the API's own role. A
 * narrow interface, so the adapter's logic is tested against a fake (tests/fake-web-functions.ts)
 * that runs revisions as local processes. `LambdaWebFunctions` is the real one, on
 * @aws-sdk/client-lambda-web.
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import {
  CreateWebFunctionCommand,
  CreateWebFunctionEndpointCommand,
  CreateWebFunctionRevisionCommand,
  DeleteWebFunctionCommand,
  DeleteWebFunctionRevisionCommand,
  GetWebAccountSettingsCommand,
  GetWebFunctionCommand,
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  LambdaWebClient,
  ListTagsCommand,
  ListWebFunctionRevisionsCommand,
  ListWebFunctionsCommand,
  PutResourcePolicyCommand,
  ResourceNotFoundException,
  type ServiceConfig,
  TagResourceCommand,
  UpdateWebFunctionEndpointCommand,
} from '@aws-sdk/client-lambda-web'
import { SignatureV4 } from '@smithy/signature-v4'

/** One revision's code and configuration: what CreateWebFunctionRevision takes. */
export interface RevisionSpec {
  /** names the version and the configuration it runs with (site-servers.ts `revisionLabel`) */
  description: string
  zip: { bucket: string; key: string; versionId: string }
  roleArn: string
  timeoutSeconds: number
  environment: Record<string, string>
  /** the egress network connector (versioned ARN), when outbound traffic is fenced */
  connectorArn?: string
}

export interface RevisionWeight {
  revisionId: string
  weight: number
}

export interface EndpointSettings {
  rateLimit: number
  maxEnvironments: number
}

export interface EndpointState extends EndpointSettings {
  domainName: string
  weights: RevisionWeight[]
  /** Pending, Active, Failed, Deleting */
  state: string
  /** InProgress while a change rolls out */
  updating: boolean
}

export interface RevisionState {
  revisionId: string
  description: string
  /** Pending, Active, Failed */
  state: string
  stateReason?: string
  createdAt: Date
}

export interface WebFunctionsApi {
  /** A function with its first revision and endpoint; its ARN, that revision and the endpoint's domain. */
  createFunction(input: {
    name: string
    tags: Record<string, string>
    revision: RevisionSpec
    endpoint: { name: string } & EndpointSettings
  }): Promise<{ arn: string; revisionId: string; domainName: string }>
  /** null when there is none */
  getFunction(name: string): Promise<{ arn: string } | null>
  /** Every function whose name starts with `prefix`. */
  listFunctions(prefix: string): Promise<{ name: string; arn: string }[]>
  /** Deletes its endpoints and revisions too; nothing when it is gone already. */
  deleteFunction(name: string): Promise<void>
  tags(arn: string): Promise<Record<string, string>>
  tag(arn: string, tags: Record<string, string>): Promise<void>
  createRevision(name: string, spec: RevisionSpec): Promise<string>
  getRevision(name: string, revisionId: string): Promise<RevisionState | null>
  listRevisions(name: string): Promise<RevisionState[]>
  deleteRevision(name: string, revisionId: string): Promise<void>
  createEndpoint(
    name: string,
    endpoint: { name: string; weights: RevisionWeight[] } & EndpointSettings
  ): Promise<{ domainName: string }>
  getEndpoint(name: string, endpoint: string): Promise<EndpointState | null>
  updateEndpoint(
    name: string,
    endpoint: string,
    change: Partial<EndpointSettings> & { weights?: RevisionWeight[] }
  ): Promise<void>
  /** Replace the function's resource policy (a JSON document). */
  putResourcePolicy(arn: string, policy: string): Promise<void>
  /** The account's quota of Arm vCPUs for every Web Function together. */
  maxArmVCpus(): Promise<number>
  /** A request to an endpoint (its domain name), signed with the API's credentials. */
  fetch(domainName: string, request: Request, signal?: AbortSignal): Promise<Response>
}

const RUNTIME = 'nodejs24.x'
const ENTRYPOINT_ENV = 'AWS_LAMBDA_NODEJS_ENTRYPOINT'

const serviceConfig = (spec: RevisionSpec, entry: string): ServiceConfig => ({
  executionRoleArn: spec.roleArn,
  timeoutSeconds: spec.timeoutSeconds,
  environmentVariables: { ...spec.environment, [ENTRYPOINT_ENV]: entry },
  ...(spec.connectorArn ? { egressNetworkConnectorArn: spec.connectorArn } : {}),
})

const buildConfig = (spec: RevisionSpec) => ({
  codeConfig: { s3Object: spec.zip },
  runtimeConfig: { runtime: RUNTIME },
})

const notFound = (err: unknown) => err instanceof ResourceNotFoundException

/** Lambda Web Functions through the AWS SDK, in the API's Region and with its credentials. */
export class LambdaWebFunctions implements WebFunctionsApi {
  constructor(
    /** the file Lambda starts in every revision's zip */
    private readonly entry: string,
    private readonly client = new LambdaWebClient({})
  ) {}

  async createFunction(input: Parameters<WebFunctionsApi['createFunction']>[0]) {
    const res = await this.client.send(
      new CreateWebFunctionCommand({
        functionName: input.name,
        tags: input.tags,
        revisionConfig: {
          description: input.revision.description,
          buildConfig: buildConfig(input.revision),
          serviceConfig: serviceConfig(input.revision, this.entry),
        },
        endpointConfig: {
          endpointName: input.endpoint.name,
          endpointType: 'HomeRegion',
          authType: 'IamAuth',
          autoDeploymentMode: 'Disabled',
          throttleConfig: { rateLimit: input.endpoint.rateLimit },
          scalingConfig: { maxEnvironments: input.endpoint.maxEnvironments },
        },
      })
    )
    return {
      arn: res.functionArn ?? '',
      revisionId: res.revision?.revisionId ?? '',
      domainName: res.endpoint?.domainName ?? '',
    }
  }

  async getFunction(name: string) {
    try {
      const res = await this.client.send(new GetWebFunctionCommand({ functionName: name }))
      return { arn: res.functionArn ?? '' }
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }

  async listFunctions(prefix: string) {
    const out: { name: string; arn: string }[] = []
    let nextToken: string | undefined
    do {
      const res = await this.client.send(new ListWebFunctionsCommand({ nextToken }))
      for (const f of res.functions ?? []) {
        if (f.functionName?.startsWith(prefix))
          out.push({ name: f.functionName, arn: f.functionArn ?? '' })
      }
      nextToken = res.nextToken
    } while (nextToken)
    return out
  }

  async deleteFunction(name: string) {
    try {
      await this.client.send(new DeleteWebFunctionCommand({ functionName: name }))
    } catch (err) {
      if (!notFound(err)) throw err
    }
  }

  async tags(arn: string) {
    const res = await this.client.send(new ListTagsCommand({ resource: arn }))
    return res.tags ?? {}
  }

  async tag(arn: string, tags: Record<string, string>) {
    await this.client.send(new TagResourceCommand({ resource: arn, tags }))
  }

  async createRevision(name: string, spec: RevisionSpec) {
    const res = await this.client.send(
      new CreateWebFunctionRevisionCommand({
        functionName: name,
        description: spec.description,
        buildConfig: buildConfig(spec),
        serviceConfig: serviceConfig(spec, this.entry),
      })
    )
    return res.revisionId ?? ''
  }

  async getRevision(name: string, revisionId: string) {
    try {
      const r = await this.client.send(
        new GetWebFunctionRevisionCommand({ functionName: name, revisionId })
      )
      return {
        revisionId: r.revisionId ?? revisionId,
        description: r.description ?? '',
        state: r.state ?? 'Pending',
        ...(r.stateReason ? { stateReason: r.stateReason } : {}),
        createdAt: r.createdAt ?? new Date(0),
      }
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }

  async listRevisions(name: string) {
    const out: RevisionState[] = []
    let nextToken: string | undefined
    try {
      do {
        const res = await this.client.send(
          new ListWebFunctionRevisionsCommand({ functionName: name, nextToken })
        )
        for (const r of res.revisions ?? []) {
          out.push({
            revisionId: r.revisionId ?? '',
            description: r.description ?? '',
            state: r.state ?? 'Pending',
            ...(r.stateReason ? { stateReason: r.stateReason } : {}),
            createdAt: r.createdAt ?? new Date(0),
          })
        }
        nextToken = res.nextToken
      } while (nextToken)
    } catch (err) {
      if (notFound(err)) return []
      throw err
    }
    return out
  }

  async deleteRevision(name: string, revisionId: string) {
    try {
      await this.client.send(
        new DeleteWebFunctionRevisionCommand({ functionName: name, revisionId })
      )
    } catch (err) {
      if (!notFound(err)) throw err
    }
  }

  async createEndpoint(name: string, e: Parameters<WebFunctionsApi['createEndpoint']>[1]) {
    const res = await this.client.send(
      new CreateWebFunctionEndpointCommand({
        functionName: name,
        endpointName: e.name,
        endpointType: 'HomeRegion',
        authType: 'IamAuth',
        autoDeploymentMode: 'Disabled',
        revisionWeights: e.weights,
        throttleConfig: { rateLimit: e.rateLimit },
        scalingConfig: { maxEnvironments: e.maxEnvironments },
      })
    )
    return { domainName: res.domainName ?? '' }
  }

  async getEndpoint(name: string, endpoint: string): Promise<EndpointState | null> {
    try {
      const e = await this.client.send(
        new GetWebFunctionEndpointCommand({ functionName: name, endpointName: endpoint })
      )
      return {
        domainName: e.domainName ?? '',
        weights: (e.revisionWeights ?? []).map(w => ({
          revisionId: w.revisionId ?? '',
          weight: w.weight ?? 0,
        })),
        rateLimit: e.throttleConfig?.rateLimit ?? 0,
        maxEnvironments: e.scalingConfig?.maxEnvironments ?? 0,
        state: e.state ?? 'Pending',
        updating: e.updateStatus === 'InProgress',
      }
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }

  async updateEndpoint(
    name: string,
    endpoint: string,
    change: Parameters<WebFunctionsApi['updateEndpoint']>[2]
  ) {
    await this.client.send(
      new UpdateWebFunctionEndpointCommand({
        functionName: name,
        endpointName: endpoint,
        ...(change.weights ? { revisionWeights: change.weights } : {}),
        ...(change.rateLimit !== undefined
          ? { throttleConfig: { rateLimit: change.rateLimit } }
          : {}),
        ...(change.maxEnvironments !== undefined
          ? { scalingConfig: { maxEnvironments: change.maxEnvironments } }
          : {}),
      })
    )
  }

  async putResourcePolicy(arn: string, policy: string) {
    await this.client.send(new PutResourcePolicyCommand({ resourceArn: arn, policy }))
  }

  async maxArmVCpus() {
    const res = await this.client.send(new GetWebAccountSettingsCommand({}))
    return res.accountQuotas?.maxTotalArmVCpus ?? 0
  }

  async fetch(domainName: string, request: Request, signal?: AbortSignal) {
    const url = new URL(request.url)
    const query: Record<string, string | string[]> = {}
    for (const [k, v] of url.searchParams) {
      const had = query[k]
      query[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v]
    }
    const signer = new SignatureV4({
      service: 'lambda',
      region: await this.client.config.region(),
      credentials: this.client.config.credentials,
      sha256: Sha256,
    })
    const signed = await signer.sign({
      method: request.method,
      protocol: 'https:',
      hostname: domainName,
      path: url.pathname,
      query,
      headers: { host: domainName, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    })
    const headers = new Headers(request.headers)
    for (const [k, v] of Object.entries(signed.headers)) if (k !== 'host') headers.set(k, v)
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    return fetch(`https://${domainName}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: 'manual',
      ...(signal ? { signal } : {}),
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit)
  }
}
