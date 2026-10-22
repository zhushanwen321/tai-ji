// index.ts — @zhushanwen/pi-wool-shared 公共面（下游三家 + u-host 消费的契约出口）。

export { isWoolFamilyId, woolProviderId, WOOL_FAMILY_IDS, type WoolCredentialsSource, type WoolFamilyId } from "./types.ts";

export {
	parseWoolManageRequest,
	registerWoolManageCommand,
	woolManageFail,
	woolManageOk,
	woolManageCommandName,
	isWoolManageResponse,
	WOOL_MANAGE_ACTIONS,
	WOOL_MANAGE_ENTRY_TYPE,
	WOOL_MANAGE_ERROR_CODES,
	WOOL_MANAGE_PROTOCOL_VERSION,
	WoolManageRequestError,
	type WoolManageAction,
	type WoolManageActionContext,
	type WoolManageActionHandler,
	type WoolCredentialAcquireData,
	type WoolManageErrorCode,
	type WoolManageHandlers,
	type WoolManageRequest,
	type WoolManageResponse,
} from "./manage-protocol.ts";

export {
	isWoolAccountStatus,
	woolLoggedOutStatus,
	WoolAccountStatusSchema,
	WoolCheckinSchema,
	WoolQuotaSchema,
	type WoolAccountStatus,
} from "./account-status.ts";

export {
	createModelCatalogStore,
	readSnapshotFile,
	toPersistEntry,
	type WoolCatalogSnapshot,
	type WoolCatalogSource,
	type WoolModelCatalogStore,
} from "./model-catalog.ts";

export { parseSseStream, readSseEvents, sseBodyFromChunks, sseDataChunk, type SseEvent } from "./sse.ts";

export {
	createAssistantStream,
	WoolStreamAdapterError,
	type WoolStreamDriverContext,
	type WoolStreamOutcome,
} from "./stream-adapter.ts";

export {
	defineWoolExtension,
	WOOL_CREDENTIALS_MISSING_MESSAGE,
	type WoolFamilyExtensionDefinition,
	type WoolFetchModelsContext,
	type WoolResolvedAuth,
	type WoolStreamImplementation,
	type WoolStreamRequest,
} from "./scaffold.ts";
