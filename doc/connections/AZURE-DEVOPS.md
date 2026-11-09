# Azure DevOps repository connections

Azure DevOps Services organizations can be connected from Apps using a Microsoft
Entra ID authorization or a personal access token (PAT). Enter the organization
name from `https://dev.azure.com/{organization}`. Azure DevOps Server and the
Azure DevOps remote MCP connection are not repository credentials.

For Entra, register an application for the Paperclip callback and grant the
Azure DevOps delegated permissions requested during setup. Choose the separate
read/write connection method only if the agent needs to push; it also grants
other Azure DevOps code-writing actions supported by that permission. A PAT needs Code
(Read) for repository discovery and cloning, and Code (Read & Write) for pushes
where the identity and repository policies allow them. Prefer short-lived PATs.
Credentials are stored in the Paperclip vault; they are not part of project
repository URLs or project metadata.

Project repository selection lists repositories available through active,
company-installed connections. Names include the organization and project. An
existing selection remains visible if access disappears; reconnect the account
and restore repository permissions before using it. Agent Git operations require
an active authorized run and an eligible connection for that agent or its
responsible user. Repository access is checked again before credentials are used.
When multiple eligible connections target the same organization, select the
authorization for the task’s project in project settings; runs use that choice
only when it is also available to their own agent or responsible user. The same
applies to an additional referenced project. If the same repository is bound to
multiple projects in one run, choose a single project workspace to
avoid an ambiguous authorization.
Agent shell Git uses the managed Git broker. In host GitHub mode, Azure operations
still use the broker; multi-remote operations require selecting one repository.
Provider-owned task runtimes may have their own Git integration and do not yet
support Azure through this broker. Background preparation of additional project workspaces uses the
project's selected authorization; workspace-provider plugins may have their own
repository restrictions.

Project repositories can also supply skills. When several projects share a skill
source, Paperclip checks every project's authorization before updating or
recovering the shared source. If a project retains historical skill access after
its repository is detached, updates to that shared source are paused until the
project repository is reattached. Installed skill copies are kept.
Standalone skill URL imports currently accept GitHub sources only; Azure project
repositories can supply project skills as described above. Company package
imports can select an authorized Azure project repository as their source. The
package must contain a root COMPANY.md, and the selecting user or agent must
retain access to the project and its repository connection. External integrations
that accept only GitHub sources continue to require GitHub.

The connector catalog's repository tool only reads repository metadata. Git
operations have separate authorization and must also satisfy the selected
identity's Azure DevOps permissions. Consult your Azure DevOps organization
administrator if sign-in, token creation, or repository access is restricted.

An organization identity is an explicit sharing choice. It initially permits all
organization members; use the connection's Permissions page to restrict it to
selected members. Agent Git access also requires an active responsible member
in that audience and an installation for the agent or company. A personal
identity remains the default when creating an Azure DevOps connection.
