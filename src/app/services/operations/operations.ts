import { Injectable } from '@angular/core'
import { LoadingController, ToastController } from '@ionic/angular'
import {
  AirGapMarketWallet,
  DelegationInfo,
  EncodedType,
  IAirGapTransaction,
  SyncProtocolUtils,
  TezosKtProtocol,
  TezosProtocol,
  CosmosProtocol
} from 'airgap-coin-lib'
import { RawAeternityTransaction } from 'airgap-coin-lib/dist/serializer/unsigned-transactions/aeternity-transactions.serializer'
import { RawBitcoinTransaction } from 'airgap-coin-lib/dist/serializer/unsigned-transactions/bitcoin-transactions.serializer'
import { RawEthereumTransaction } from 'airgap-coin-lib/dist/serializer/unsigned-transactions/ethereum-transactions.serializer'
import { RawTezosTransaction } from 'airgap-coin-lib/dist/serializer/unsigned-transactions/tezos-transactions.serializer'
import BigNumber from 'bignumber.js'
import { BehaviorSubject } from 'rxjs'
import { map } from 'rxjs/operators'

import { AccountProvider } from '../account/account.provider'
import { ProtocolSymbols } from '../protocols/protocols'
import { ErrorCategory, handleErrorSentry } from '../sentry-error-handler/sentry-error-handler'

@Injectable({
  providedIn: 'root'
})
export class OperationsProvider {
  private readonly delegationStatuses: BehaviorSubject<Map<string, boolean>> = new BehaviorSubject(new Map())

  constructor(
    private readonly accountProvider: AccountProvider,
    private readonly loadingController: LoadingController,
    private readonly toastController: ToastController
  ) {}

  public setDelegationStatusOfAddress(address: string, delegated: boolean) {
    this.delegationStatuses.next(this.delegationStatuses.getValue().set(address, delegated))
  }

  public async getDelegationStatusOfAddress(address: string, refresh: boolean = false) {
    const delegationStatus = this.delegationStatuses.getValue().get(address)
    if (refresh || delegationStatus === undefined) {
      const isDelegated = await this.checkDelegated(address)
      this.setDelegationStatusOfAddress(address, isDelegated)

      return isDelegated
    } else {
      return delegationStatus
    }
  }

  public async getDelegationStatusObservableOfAddress(address) {
    await this.getDelegationStatusOfAddress(address)

    return this.delegationStatuses.pipe(map(delegationStatuses => delegationStatuses.get(address)))
  }

  public refreshAllDelegationStatuses() {
    Array.from(this.delegationStatuses.getValue().entries()).forEach(entry => {
      this.getDelegationStatusOfAddress(entry[0], true).catch(handleErrorSentry(ErrorCategory.OPERATIONS_PROVIDER))
    })
  }

  private async serializeTx(
    wallet: AirGapMarketWallet,
    transaction: RawTezosTransaction | RawEthereumTransaction | RawBitcoinTransaction | RawAeternityTransaction
  ) {
    const syncProtocol = new SyncProtocolUtils()

    return syncProtocol.serialize({
      version: 1,
      protocol: wallet.coinProtocol.identifier,
      type: EncodedType.UNSIGNED_TRANSACTION,
      payload: {
        publicKey: wallet.publicKey,
        transaction,
        callback: 'airgap-wallet://?d='
      }
    })
  }

  public async checkDelegated(address: string): Promise<boolean> {
    if (address.startsWith('cosmos')) {
      // TODO: this is ugly and needs to be re-implemented properly
      const protocol = new CosmosProtocol()
      const delegations = await protocol.fetchDelegations(address)
      return delegations.length > 0
    } else {
      return (await this.fetchDelegationInfo(address)).isDelegated
    }
  }

  public async fetchDelegationInfo(address: string): Promise<DelegationInfo> {
    const protocol = new TezosKtProtocol()
    return protocol.isAddressDelegated(address)
  }

  public async prepareTransaction(
    wallet: AirGapMarketWallet,
    address: string,
    amount: BigNumber,
    fee: BigNumber,
    data?: any
  ): Promise<{ airGapTx: IAirGapTransaction; serializedTx: string }> {
    const loader = await this.getAndShowLoader()

    try {
      // TODO: This is an UnsignedTransaction, not an IAirGapTransaction
      const rawUnsignedTx: any = await wallet.prepareTransaction([address], [amount], fee, data)

      const airGapTx: IAirGapTransaction = (await wallet.coinProtocol.getTransactionDetails({
        publicKey: wallet.publicKey,
        transaction: rawUnsignedTx
      }))[0]

      const serializedTx = await this.serializeTx(wallet, rawUnsignedTx)

      return { airGapTx, serializedTx }
    } catch (error) {
      handleErrorSentry(ErrorCategory.COINLIB)(error)

      this.toastController
        .create({
          message: error.message,
          duration: 3000,
          position: 'bottom'
        })
        .then(toast => {
          toast.present().catch(handleErrorSentry(ErrorCategory.IONIC_TOAST))
        })
      throw error
    } finally {
      this.hideLoader(loader)
    }
  }

  public async addKtAddress(xtzWallet: AirGapMarketWallet, index: number, ktAddresses: string[]): Promise<AirGapMarketWallet> {
    let wallet = this.accountProvider.walletByPublicKeyAndProtocolAndAddressIndex(xtzWallet.publicKey, ProtocolSymbols.XTZ_KT, index)

    if (wallet) {
      return wallet
    }

    wallet = new AirGapMarketWallet(
      ProtocolSymbols.XTZ_KT,
      xtzWallet.publicKey,
      xtzWallet.isExtendedPublicKey,
      xtzWallet.derivationPath,
      index
    )
    wallet.addresses = ktAddresses
    await wallet.synchronize().catch(handleErrorSentry(ErrorCategory.COINLIB))
    await this.accountProvider.addWallet(wallet).catch(handleErrorSentry(ErrorCategory.WALLET_PROVIDER))

    return wallet
  }

  private async getAndShowLoader() {
    const loader = await this.loadingController.create({
      message: 'Preparing transaction...'
    })

    await loader.present().catch(handleErrorSentry(ErrorCategory.IONIC_LOADER))

    return loader
  }

  private hideLoader(loader: HTMLIonLoadingElement) {
    loader.dismiss().catch(handleErrorSentry(ErrorCategory.IONIC_LOADER))
  }
}
