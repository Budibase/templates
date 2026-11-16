# Budibase Templates

For native Project templates, use the [Project publishing workflow](#project-templates) below. The existing app template workflow remains available. The [`v2-archive` branch](https://github.com/Budibase/templates/tree/v2-archive) preserves this repository before the Project publisher was introduced.

## Adding a Template

To add a new template to this repository, you need to perform these steps:

First, export your app from the builder.

<img width="366" alt="Screenshot 2021-11-04 at 15 46 50" src="https://user-images.githubusercontent.com/11256663/140335367-1589369d-01b6-47ce-877e-193848258f2a.png">

Add a new folder under the `app` directory in the repo. Ensure that your folder name is all lowercase, and separated with dashes. For example:
`app/my-new-template`

<img width="1433" alt="Screenshot 2021-11-04 at 15 47 04" src="https://user-images.githubusercontent.com/11256663/140335420-3da25fa2-0e95-4caa-bd1e-83a5e9bf8a51.png">

Create a `definition.json`, which includes its name, icon etc. Here's an example `definition.json`:

```
{
  "name": "IT Ticketing System",
  "category": "IT",
  "description": "Keep on top of IT tickets and incoming requests for IT assistance.",
  "icon": "Help",
  "background": "#33AB84",
  "url": "https://budibase.com/business-apps/templates/open-source-ticketing-system/"
}
```

You then need to add your export file under `db/dump.txt`.
<img width="1436" alt="Screenshot 2021-11-04 at 15 47 56" src="https://user-images.githubusercontent.com/11256663/140335601-66beed19-ea92-48fe-9245-78252113b86b.png">

Merge to master, and it will automatically get picked up by BB

!<img width="737" alt="Screenshot 2021-11-04 at 15 48 07" src="https://user-images.githubusercontent.com/11256663/140335639-bcf88013-9bf2-4311-a8f0-af2e0d990f4e.png">

After merging, you create a destination URL for the template section of the website, simple append the name of your template to the end of:
https://budibase.app/builder?template=app/

For example:
https://budibase.app/builder?template=app/it-help-desk

## Project templates

Project templates use the existing repository and S3 bucket, with a separate versioned catalogue. They are native Project exports containing apps, tables, APIs, automations or agents. The legacy `manifest.json` and `templates/app/*` outputs are independent of this catalogue.

### Add a template

1. Export a Project from a Budibase release containing the template consumer and the permission-preserving Project export/import changes. Leave encryption off. Choose whether to include sample rows and attachments.
2. Create `templates/project/<lowercase-kebab-slug>/` and put the original export there as `project.tar.gz`. Preserve its bytes and native archive layout.
3. Add a `definition.json` using [the example](examples/project-template/definition.json). Set `minBudibaseVersion` to the first released Budibase version that supports this template; the example's `4.0.0` must be checked against the actual release.
4. Optionally add `preview.png`, `preview.jpg`, `preview.jpeg` or `preview.webp` beside the definition and set `image` to that filename. An existing absolute HTTPS image URL also works. Omit `image` when no preview is ready.
5. Run `yarn test`, `yarn validate:projects` and `yarn build:projects` on the Node version in `.nvmrc`. Review the generated catalogue under `dist/project/`.

The directory determines the stable key, for example `project/service-desk`. The builder calculates archive size, SHA-256 and package format version; authors supply the display metadata, template version, owner and compatibility range. Current consumers support `requiredFeatures: ["projects"]` or an empty list. Other feature names are rejected during validation.

Use `x.y.z` template versions. Bump the version when changing the archive or a local preview, because published versioned files are immutable. Metadata-only changes produce a new catalogue release. To remove a template from discovery and prevent new imports, set its status to `withdrawn` and retain its source files. Deprecated entries require a `deprecation.message` and may include a `replacementKey`.

The archive must be an unencrypted native Project package from the permission-preserving exporter, with `containsPermissions: true` and `permissions.json`, at most 50 MiB compressed and 100 MiB expanded. The builder rejects legacy workspace/app exports, invalid manifests, unsafe archive paths, links and oversized packages. Publishing exposes the archive to public download, so use suitable sample data and verify the export's contents.

### Build and publish

`yarn build:projects` creates a reviewable local build and `publication.json` plan. It never contacts AWS. `yarn publish:projects` publishes that exact plan; `yarn publish:projects:ci` runs both in order.

| Setting                                                                    | Purpose                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_S3_BUCKET`                                                            | Existing target bucket; required for a nonempty publication.                                                                                        |
| `AWS_REGION`                                                               | Bucket region; defaults to `eu-west-1`.                                                                                                             |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN` | Standard AWS credentials; the SDK credential chain also supports local profiles and roles.                                                          |
| `PROJECT_TEMPLATE_REPOSITORY_URL`                                          | Public HTTPS origin without a path prefix. Defaults to the target bucket's regional S3 URL, or the Budibase production origin for local validation. |
| `PROJECT_CATALOGUE_VERSION`                                                | Immutable catalogue release identifier. CI uses the workflow run ID and attempt; local builds default to a timestamp.                               |
| `PROJECT_CATALOGUE_PUBLISHED_AT`                                           | Optional ISO publication timestamp for a reproducible local build.                                                                                  |
| `PROJECT_TEMPLATE_OUTPUT_PATH`                                             | Optional local output directory; defaults to `dist/project`.                                                                                        |

The publisher writes only these paths:

```text
artifacts/project/<slug>/<version>/project.tar.gz
artifacts/project/<slug>/<version>/<optional-preview>
catalogue/project/v1/releases/<catalogue-version>.json
catalogue/project/v1/current.json
```

It validates local bytes, checks existing immutable objects, uploads and verifies artefacts and the release, and replaces `current.json` last. Before promotion, every versioned object must also pass an anonymous HTTPS download with matching size and SHA-256 from the configured public origin, including reused objects. Public checks reject redirects and time out after 15 seconds. A failure before promotion leaves the previous pointer active. Matching immutable files are reused; different bytes at an existing version fail. The Project publisher uses only `GetObject` and `PutObject`, and does not create buckets or replace bucket policies. Grant those operations for the two Project prefixes, plus bucket-level `s3:ListBucket` so S3 returns a distinguishable missing-object response during preflight. Without that permission, S3 returns `403` for missing objects; see the [GetObject permissions documentation](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html). An empty source directory skips publication and keeps any existing remote catalogue active.

The bucket or CDN must serve the catalogue and artefacts anonymously over HTTPS without redirects. Previews must also be browser-readable. Serve archives as `application/gzip`, without `Content-Encoding: gzip`; the consumer verifies the compressed bytes. Versioned files use immutable caching; the active pointer uses `no-cache`. Rollback consists of restoring the pointer's previous catalogue version and checksum.

Pull requests run validation and tests without AWS credentials. Merges to `master` and manual workflow runs from `master` publish legacy templates and the Project catalogue in separate jobs, using the existing AWS repository secrets. Production workflow runs are serialised; manual runs on other branches only validate. Set the optional repository variable `PROJECT_TEMPLATE_REPOSITORY_URL` only when the public origin differs from the bucket's regional URL. No production Project entry is included in this change; the first real template must be supplied by its content owner.

### Budibase rollout

The three application PRs ([catalogue/import](https://github.com/Budibase/budibase/pull/19862), [gallery](https://github.com/Budibase/budibase/pull/19863), [links/destinations](https://github.com/Budibase/budibase/pull/19864)) must be deployed across server, builder and worker, including their final review fixes and the permission-preserving importer. Enable both `PROJECTS` and `TEMPLATES`. The server's `PROJECT_TEMPLATE_REPOSITORY_URL` must point to the same public root used here; its current default is `https://prod-budi-templates.s3-eu-west-1.amazonaws.com`.

Website CTAs must reach the deployed builder, for example `/builder?template=project%2Fservice-desk`. The website's currently reserved import/download fields also need their menu activated. Verify existing-user and new-signup journeys across Cloud tenant domains using the normal cookie/JWT configuration. External credentials and other import setup requirements still need to be completed by the installing user.

After the initial rollout and one real hosted import are verified, publishing further compatible templates is a content operation with no Budibase code deployment.
