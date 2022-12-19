import { err, errAsync, ok, ResultAsync } from 'neverthrow';
import CastStore from '~/storage/sets/flatbuffers/castStore';
import RocksDB from '~/storage/db/binaryrocksdb';
import SignerStore from '~/storage/sets/flatbuffers/signerStore';
import FollowStore from '~/storage/sets/flatbuffers/followStore';
import ReactionStore from '~/storage/sets/flatbuffers/reactionStore';
import VerificationStore from '~/storage/sets/flatbuffers/verificationStore';
import UserDataStore from '~/storage/sets/flatbuffers/userDataStore';
import MessageModel from '~/storage/flatbuffers/messageModel';
import {
  CastAddModel,
  CastRemoveModel,
  FollowAddModel,
  FollowRemoveModel,
  ReactionAddModel,
  ReactionRemoveModel,
  SignerAddModel,
  SignerRemoveModel,
  UserDataAddModel,
  UserPostfix,
  VerificationAddEthAddressModel,
  VerificationRemoveModel,
} from '~/storage/flatbuffers/types';
import IdRegistryEventModel from '~/storage/flatbuffers/idRegistryEventModel';
import { IdRegistryEventType } from '~/utils/generated/id_registry_event_generated';
import { isSignerAdd, isSignerRemove, isUserDataAdd } from '~/storage/flatbuffers/typeguards';
import {
  validateCastId,
  ValidatedCastId,
  ValidatedUserId,
  validateEd25519PublicKey,
  validateEthAddress,
  validateFid,
  validateMessage,
  validateReactionType,
  validateTsHash,
  validateUserId,
} from '~/storage/flatbuffers/validations';
import { CastId, MessageType, ReactionType, UserDataType, UserId } from '~/utils/generated/message_generated';
import { HubAsyncResult, HubResult, HubError } from '~/utils/hubErrors';
import StoreEventHandler from '~/storage/sets/flatbuffers/storeEventHandler';
import { NameRegistryEventType } from '~/utils/generated/name_registry_event_generated';
import NameRegistryEventModel from '~/storage/flatbuffers/nameRegistryEventModel';
import { bytesCompare } from '~/storage/flatbuffers/utils';
import { logger } from '~/utils/logger';
import HubStateModel from '~/storage/flatbuffers/hubStateModel';

class Engine {
  public eventHandler: StoreEventHandler;

  private _db: RocksDB;
  private _castStore: CastStore;
  private _signerStore: SignerStore;
  private _followStore: FollowStore;
  private _reactionStore: ReactionStore;
  private _verificationStore: VerificationStore;
  private _userDataStore: UserDataStore;

  // TODO: add ID Registry connection

  constructor(db: RocksDB) {
    this.eventHandler = new StoreEventHandler();

    this._db = db;
    this._castStore = new CastStore(db, this.eventHandler);
    this._signerStore = new SignerStore(db, this.eventHandler);
    this._followStore = new FollowStore(db, this.eventHandler);
    this._reactionStore = new ReactionStore(db, this.eventHandler);
    this._verificationStore = new VerificationStore(db, this.eventHandler);
    this._userDataStore = new UserDataStore(db, this.eventHandler);
  }

  async mergeMessages(messages: MessageModel[], source = 'unknown'): Promise<Array<HubResult<void>>> {
    const results: HubResult<void>[] = [];
    for (const message of messages) {
      results.push(await this.mergeMessage(message, source));
    }
    return results;
  }

  async mergeMessage(message: MessageModel, source = 'unknown'): HubAsyncResult<void> {
    const validatedMessage = await this.validateMessage(message);
    if (validatedMessage.isErr()) {
      return err(validatedMessage.error);
    }

    let result: ResultAsync<void, HubError>;
    if (message.setPostfix() === UserPostfix.CastMessage) {
      result = ResultAsync.fromPromise(this._castStore.merge(message), (e) => e as HubError);
    } else if (message.setPostfix() === UserPostfix.FollowMessage) {
      result = ResultAsync.fromPromise(this._followStore.merge(message), (e) => e as HubError);
    } else if (message.setPostfix() === UserPostfix.ReactionMessage) {
      result = ResultAsync.fromPromise(this._reactionStore.merge(message), (e) => e as HubError);
    } else if (message.setPostfix() === UserPostfix.SignerMessage) {
      result = ResultAsync.fromPromise(this._signerStore.merge(message), (e) => e as HubError);
    } else if (message.setPostfix() === UserPostfix.VerificationMessage) {
      result = ResultAsync.fromPromise(this._verificationStore.merge(message), (e) => e as HubError);
    } else if (message.setPostfix() === UserPostfix.UserDataMessage) {
      result = ResultAsync.fromPromise(this._userDataStore.merge(message), (e) => e as HubError);
    } else {
      return err(new HubError('bad_request.validation_failure', 'invalid message type'));
    }

    return result.then((res) => {
      if (res.isOk()) {
        const messageType = message.data.type();
        // It's safe to convert the message type to its enum string since the message has already been validated.
        // eslint-disable-next-line security/detect-object-injection
        logger.info(
          {
            component: 'engine',
            hash: message.hash,
            fid: message.data.fid,
            type: messageType ? MessageType[messageType] : 'Unknown',
            source,
          },
          'mergeMessage'
        );
      }
      return res;
    });
  }

  async mergeIdRegistryEvent(event: IdRegistryEventModel, source = 'unknown'): HubAsyncResult<void> {
    if (
      event.type() === IdRegistryEventType.IdRegistryRegister ||
      event.type() === IdRegistryEventType.IdRegistryTransfer
    ) {
      // It's safe to convert the event type to its enum string as it has already been validated.
      // eslint-disable-next-line security/detect-object-injection
      logger.info(
        {
          component: 'engine',
          event: IdRegistryEventType[event.type()],
          source,
        },
        'mergeIdRegistryEvent'
      );
      return ResultAsync.fromPromise(this._signerStore.mergeIdRegistryEvent(event), (e) => e as HubError);
    } else {
      return err(new HubError('bad_request.validation_failure', 'invalid event type'));
    }
  }

  async mergeNameRegistryEvent(event: NameRegistryEventModel, source = 'unknown'): HubAsyncResult<void> {
    if (
      event.type() === NameRegistryEventType.NameRegistryTransfer ||
      event.type() === NameRegistryEventType.NameRegistryRenew
    ) {
      // It's safe to convert the event type to its enum string as it has already been validated.
      // eslint-disable-next-line security/detect-object-injection
      logger.info(
        {
          component: 'engine',
          event: NameRegistryEventType[event.type()],
          source,
        },
        'mergeNameRegistryEvent'
      );
      return ResultAsync.fromPromise(this._userDataStore.mergeNameRegistryEvent(event), (e) => e as HubError);
    }

    return err(new HubError('bad_request.validation_failure', 'invalid event type'));
  }

  async revokeMessagesBySigner(fid: Uint8Array, signer: Uint8Array): HubAsyncResult<void> {
    await this._castStore.revokeMessagesBySigner(fid, signer);
    await this._followStore.revokeMessagesBySigner(fid, signer);
    await this._reactionStore.revokeMessagesBySigner(fid, signer);
    await this._verificationStore.revokeMessagesBySigner(fid, signer);
    await this._userDataStore.revokeMessagesBySigner(fid, signer);
    await this._signerStore.revokeMessagesBySigner(fid, signer);

    return ok(undefined);
  }

  /* -------------------------------------------------------------------------- */
  /*                             Cast Store Methods                             */
  /* -------------------------------------------------------------------------- */

  async getCast(fid: Uint8Array, tsHash: Uint8Array): HubAsyncResult<CastAddModel> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedTsHash = validateTsHash(tsHash);
    if (validatedTsHash.isErr()) {
      return err(validatedTsHash.error);
    }

    return ResultAsync.fromPromise(this._castStore.getCastAdd(fid, tsHash), (e) => e as HubError);
  }

  async getCastsByFid(fid: Uint8Array): HubAsyncResult<CastAddModel[]> {
    return validateFid(fid).match(
      (validatedFid: Uint8Array) => {
        return ResultAsync.fromPromise(this._castStore.getCastAddsByUser(validatedFid), (e) => e as HubError);
      },
      (e) => {
        return errAsync(e);
      }
    );
  }

  async getCastsByParent(parent: CastId): HubAsyncResult<CastAddModel[]> {
    return validateCastId(parent).match(
      (validatedParent: ValidatedCastId) => {
        return ResultAsync.fromPromise(
          this._castStore.getCastsByParent(validatedParent.fidArray(), validatedParent.tsHashArray()),
          (e) => e as HubError
        );
      },
      (e) => {
        return errAsync(e);
      }
    );
  }

  async getCastsByMention(user: UserId): HubAsyncResult<CastAddModel[]> {
    return validateUserId(user).match(
      (validatedUserId: ValidatedUserId) => {
        return ResultAsync.fromPromise(
          this._castStore.getCastsByMention(validatedUserId.fidArray()),
          (e) => e as HubError
        );
      },
      (e) => {
        return errAsync(e);
      }
    );
  }

  async getAllCastMessagesByFid(fid: Uint8Array): HubAsyncResult<(CastAddModel | CastRemoveModel)[]> {
    const adds = await ResultAsync.fromPromise(this._castStore.getCastAddsByUser(fid), (e) => e as HubError);
    if (adds.isErr()) {
      return err(adds.error);
    }

    const removes = await ResultAsync.fromPromise(this._castStore.getCastRemovesByUser(fid), (e) => e as HubError);
    if (removes.isErr()) {
      return err(removes.error);
    }

    return ok([...adds.value, ...removes.value]);
  }

  /* -------------------------------------------------------------------------- */
  /*                             Follow Store Methods                           */
  /* -------------------------------------------------------------------------- */

  async getFollow(fid: Uint8Array, user: UserId): HubAsyncResult<FollowAddModel> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedUser = validateUserId(user);
    if (validatedUser.isErr()) {
      return err(validatedUser.error);
    }

    return ResultAsync.fromPromise(
      this._followStore.getFollowAdd(fid, validatedUser.value.fidArray()),
      (e) => e as HubError
    );
  }

  async getFollowsByFid(fid: Uint8Array): HubAsyncResult<FollowAddModel[]> {
    return validateFid(fid).match(
      (validatedFid: Uint8Array) => {
        return ResultAsync.fromPromise(this._followStore.getFollowAddsByUser(validatedFid), (e) => e as HubError);
      },
      (e) => {
        return errAsync(e);
      }
    );
  }

  async getFollowsByUser(user: UserId): HubAsyncResult<FollowAddModel[]> {
    return validateUserId(user).match(
      (validatedUserId: ValidatedUserId) => {
        return ResultAsync.fromPromise(
          this._followStore.getFollowsByTargetUser(validatedUserId.fidArray()),
          (e) => e as HubError
        );
      },
      (e) => {
        return errAsync(e);
      }
    );
  }

  async getAllFollowMessagesByFid(fid: Uint8Array): HubAsyncResult<(FollowAddModel | FollowRemoveModel)[]> {
    const adds = await ResultAsync.fromPromise(this._followStore.getFollowAddsByUser(fid), (e) => e as HubError);
    if (adds.isErr()) {
      return err(adds.error);
    }

    const removes = await ResultAsync.fromPromise(this._followStore.getFollowRemovesByUser(fid), (e) => e as HubError);
    if (removes.isErr()) {
      return err(removes.error);
    }

    return ok([...adds.value, ...removes.value]);
  }

  /* -------------------------------------------------------------------------- */
  /*                            Reaction Store Methods                          */
  /* -------------------------------------------------------------------------- */

  async getReaction(fid: Uint8Array, type: ReactionType, cast: CastId): HubAsyncResult<ReactionAddModel> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedReactionType = validateReactionType(type);
    if (validatedReactionType.isErr()) {
      return err(validatedReactionType.error);
    }

    const validatedCast = validateCastId(cast);
    if (validatedCast.isErr()) {
      return err(validatedCast.error);
    }

    return ResultAsync.fromPromise(this._reactionStore.getReactionAdd(fid, type, cast), (e) => e as HubError);
  }

  async getReactionsByFid(fid: Uint8Array, type?: ReactionType): HubAsyncResult<ReactionAddModel[]> {
    return validateFid(fid).match(
      (validatedFid: Uint8Array) => {
        return ResultAsync.fromPromise(
          this._reactionStore.getReactionAddsByUser(validatedFid, type),
          (e) => e as HubError
        );
      },
      (e) => {
        return errAsync(e);
      }
    );
  }

  async getReactionsByCast(cast: CastId, type?: ReactionType): HubAsyncResult<ReactionAddModel[]> {
    return validateCastId(cast).match(
      (validatedCastId: ValidatedCastId) => {
        return ResultAsync.fromPromise(
          this._reactionStore.getReactionsByTargetCast(validatedCastId, type),
          (e) => e as HubError
        );
      },
      (e) => {
        return errAsync(e);
      }
    );
  }

  async getAllReactionMessagesByFid(fid: Uint8Array): HubAsyncResult<(ReactionAddModel | ReactionRemoveModel)[]> {
    const adds = await ResultAsync.fromPromise(this._reactionStore.getReactionAddsByUser(fid), (e) => e as HubError);
    if (adds.isErr()) {
      return err(adds.error);
    }

    const removes = await ResultAsync.fromPromise(
      this._reactionStore.getReactionRemovesByUser(fid),
      (e) => e as HubError
    );
    if (removes.isErr()) {
      return err(removes.error);
    }

    return ok([...adds.value, ...removes.value]);
  }

  /* -------------------------------------------------------------------------- */
  /*                          Verification Store Methods                        */
  /* -------------------------------------------------------------------------- */

  async getVerification(fid: Uint8Array, address: Uint8Array): HubAsyncResult<VerificationAddEthAddressModel> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedAddress = validateEthAddress(address);
    if (validatedAddress.isErr()) {
      return err(validatedAddress.error);
    }

    return ResultAsync.fromPromise(this._verificationStore.getVerificationAdd(fid, address), (e) => e as HubError);
  }

  async getVerificationsByFid(fid: Uint8Array): HubAsyncResult<VerificationAddEthAddressModel[]> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._verificationStore.getVerificationAddsByUser(fid), (e) => e as HubError);
  }

  async getAllVerificationMessagesByFid(
    fid: Uint8Array
  ): HubAsyncResult<(VerificationAddEthAddressModel | VerificationRemoveModel)[]> {
    const adds = await ResultAsync.fromPromise(
      this._verificationStore.getVerificationAddsByUser(fid),
      (e) => e as HubError
    );
    if (adds.isErr()) {
      return err(adds.error);
    }

    const removes = await ResultAsync.fromPromise(
      this._verificationStore.getVerificationRemovesByUser(fid),
      (e) => e as HubError
    );
    if (removes.isErr()) {
      return err(removes.error);
    }

    return ok([...adds.value, ...removes.value]);
  }

  /* -------------------------------------------------------------------------- */
  /*                              Signer Store Methods                          */
  /* -------------------------------------------------------------------------- */

  async getSigner(fid: Uint8Array, signerPubKey: Uint8Array): HubAsyncResult<SignerAddModel> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedPubKey = validateEd25519PublicKey(signerPubKey);
    if (validatedPubKey.isErr()) {
      return err(validatedPubKey.error);
    }

    return ResultAsync.fromPromise(this._signerStore.getSignerAdd(fid, signerPubKey), (e) => e as HubError);
  }

  async getSignersByFid(fid: Uint8Array): HubAsyncResult<SignerAddModel[]> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._signerStore.getSignerAddsByUser(fid), (e) => e as HubError);
  }

  async getCustodyEvent(fid: Uint8Array): HubAsyncResult<IdRegistryEventModel> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._signerStore.getCustodyEvent(fid), (e) => e as HubError);
  }

  async getFids(): HubAsyncResult<Uint8Array[]> {
    return ResultAsync.fromPromise(this._signerStore.getFids(), (e) => e as HubError);
  }

  async getAllSignerMessagesByFid(fid: Uint8Array): HubAsyncResult<(SignerAddModel | SignerRemoveModel)[]> {
    const adds = await ResultAsync.fromPromise(this._signerStore.getSignerAddsByUser(fid), (e) => e as HubError);
    if (adds.isErr()) {
      return err(adds.error);
    }

    const removes = await ResultAsync.fromPromise(this._signerStore.getSignerRemovesByUser(fid), (e) => e as HubError);
    if (removes.isErr()) {
      return err(removes.error);
    }

    return ok([...adds.value, ...removes.value]);
  }

  /* -------------------------------------------------------------------------- */
  /*                           User Data Store Methods                          */
  /* -------------------------------------------------------------------------- */

  async getUserData(fid: Uint8Array, type: UserDataType): HubAsyncResult<UserDataAddModel> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._userDataStore.getUserDataAdd(fid, type), (e) => e as HubError);
  }

  async getUserDataByFid(fid: Uint8Array): HubAsyncResult<UserDataAddModel[]> {
    const validatedFid = validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._userDataStore.getUserDataAddsByUser(fid), (e) => e as HubError);
  }

  /** ------------------------------------------------------------------------- */
  /*                                  Hub State Methods                         */
  /* -------------------------------------------------------------------------- */
  async getHubState(): HubAsyncResult<HubStateModel> {
    return ResultAsync.fromPromise(HubStateModel.get(this._db), (e) => e as HubError);
  }

  async updateHubState(hubState: HubStateModel): HubAsyncResult<void> {
    const txn = this._db.transaction();
    HubStateModel.putTransaction(txn, hubState);
    return await ResultAsync.fromPromise(this._db.commit(txn), (e) => e as HubError);
  }

  /* -------------------------------------------------------------------------- */
  /*                               Private Methods                              */
  /* -------------------------------------------------------------------------- */

  private async validateMessage(message: MessageModel): HubAsyncResult<MessageModel> {
    // 1. Check that the user has a custody address
    const custodyAddress = await ResultAsync.fromPromise(
      this._signerStore.getCustodyAddress(message.fid()),
      () => undefined
    );
    if (custodyAddress.isErr()) {
      return err(new HubError('bad_request.validation_failure', 'unknown user'));
    }

    // 2. Check that the signer is valid if message is not a signer message
    if (!isSignerAdd(message) && !isSignerRemove(message)) {
      const signerResult = await ResultAsync.fromPromise(
        this._signerStore.getSignerAdd(message.fid(), message.signer()),
        () => undefined
      );
      if (signerResult.isErr()) {
        return err(new HubError('bad_request.validation_failure', 'invalid signer'));
      }
    }

    // 3. For fname add UserDataAdd messages, check that the user actually owns the fname
    if (isUserDataAdd(message) && message.body().type() == UserDataType.Fname) {
      // For fname messages, check if the user actually owns the fname.
      const fname = new TextEncoder().encode(message.body().value() ?? '');

      // Users are allowed to set fname = '' to remove their fname, so check to see if fname is set
      // before validating the custody address
      if (fname && fname.length > 0) {
        const fid = message.fid();

        // The custody address of the fid and fname must be the same
        const fidCustodyAddress = await IdRegistryEventModel.get(this._db, fid).then((event) => event?.to());
        const fnameCustodyAddress = await NameRegistryEventModel.get(this._db, fname).then((event) => event?.to());

        if (bytesCompare(fidCustodyAddress, fnameCustodyAddress) !== 0) {
          return err(
            new HubError('bad_request.validation_failure', 'fname custody address does not match fid custody address')
          );
        }
      }
    }

    // 4. Check message body and envelope (will throw HubError if invalid)
    return validateMessage(message);
  }
}

export default Engine;