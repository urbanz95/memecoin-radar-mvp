import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem';
import { NETWORK, QUOTE_ASSETS, isEvmAddress } from '../network.mjs';
import { hex, hash, quantity } from './rpc.mjs';

// Reproducible Solidity source and compiled runtime are embedded below. Compilation:
// solc 0.8.30, viaIR=true, optimizer enabled/runs=200, evmVersion=paris,
// metadata.bytecodeHash=none. No compiler, wallet or deployment is used at runtime.
export const SIMULATOR_SOURCE = "// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\ninterface Token { function balanceOf(address) external view returns(uint256); }\ninterface Pair { function factory() external view returns(address); function token0() external view returns(address); function token1() external view returns(address); function getReserves() external view returns(uint112,uint112,uint32); function swap(uint256,uint256,address,bytes calldata) external; }\ninterface Factory { function getPair(address,address) external view returns(address); }\ninterface Wrapped { function deposit() external payable; }\ncontract RoundTripProbe {\n  struct Result { uint256 stage; uint256 quoteIn; uint256 buyExpected; uint256 buyReceived; uint256 sellTransferred; uint256 sellExpected; uint256 quoteReceived; bytes revertData; }\n  function clipped(bytes memory data) private pure returns(bytes memory) { if(data.length>256) assembly { mstore(data,256) } return data; }\n  function transfer(address asset,address to,uint256 amount) private {\n    (bool ok,bytes memory data)=asset.call(abi.encodeWithSignature(\"transfer(address,uint256)\",to,amount));\n    require(ok && (data.length==0 || (data.length==32 && abi.decode(data,(bool)))),\"TRANSFER_FAILED\");\n  }\n  function out(uint256 amount,uint256 reserveIn,uint256 reserveOut) private pure returns(uint256) { return amount*997*reserveOut/(reserveIn*1000+amount*997); }\n  function run(address pair,address token,address weth,address factory,uint256 amount) external returns(Result memory r) {\n    require(amount>0 && address(this).balance>=amount,\"PROBE_FUNDS\");\n    Pair p=Pair(pair); bool quote0=p.token0()==weth;\n    require(p.factory()==factory && (quote0 ? p.token1()==token : p.token0()==token && p.token1()==weth),\"POOL_IDENTITY\");\n    require(Factory(factory).getPair(token,weth)==pair,\"FACTORY_INDEX\");\n    (uint112 a,uint112 b,)=p.getReserves();\n    require(a>0 && b>0,\"NO_LIQUIDITY\");\n    require(Token(p.token0()).balanceOf(pair)==a && Token(p.token1()).balanceOf(pair)==b,\"UNSYNCED_BALANCES\");\n    r.quoteIn=amount;\n    try this.buy(pair,token,weth,amount,quote0) returns(uint256 expected,uint256 received) { r.buyExpected=expected;r.buyReceived=received; }\n    catch(bytes memory reason) { r.stage=1;r.revertData=clipped(reason);return r; }\n    try this.sell(pair,token,weth,r.buyReceived,quote0) returns(uint256 transferred,uint256 expected,uint256 received) { r.sellTransferred=transferred;r.sellExpected=expected;r.quoteReceived=received;r.stage=3; }\n    catch(bytes memory reason) { r.stage=2;r.revertData=clipped(reason); }\n  }\n  function buy(address pair,address token,address weth,uint256 amount,bool quote0) external returns(uint256 expected,uint256 received) {\n    require(msg.sender==address(this),\"SELF_ONLY\");\n    (uint112 a,uint112 b,)=Pair(pair).getReserves();expected=out(amount,quote0?a:b,quote0?b:a);require(expected>0,\"DUST_BUY\");\n    uint256 beforeBalance=Token(token).balanceOf(address(this));\n    Wrapped(weth).deposit{value:amount}();transfer(weth,pair,amount);\n    Pair(pair).swap(quote0?0:expected,quote0?expected:0,address(this),\"\");\n    received=Token(token).balanceOf(address(this))-beforeBalance;require(received>0,\"NO_BUY_OUTPUT\");\n  }\n  function sell(address pair,address token,address weth,uint256 amount,bool quote0) external returns(uint256 transferred,uint256 expected,uint256 received) {\n    require(msg.sender==address(this),\"SELF_ONLY\");\n    (uint112 a,uint112 b,)=Pair(pair).getReserves();\n    uint256 beforePair=Token(token).balanceOf(pair);transfer(token,pair,amount);\n    transferred=Token(token).balanceOf(pair)-beforePair;require(transferred>0,\"NO_SELL_INPUT\");\n    expected=out(transferred,quote0?b:a,quote0?a:b);require(expected>0,\"DUST_SELL\");\n    uint256 beforeBalance=Token(weth).balanceOf(address(this));\n    Pair(pair).swap(quote0?expected:0,quote0?0:expected,address(this),\"\");\n    received=Token(weth).balanceOf(address(this))-beforeBalance;require(received>0,\"NO_SELL_OUTPUT\");\n  }\n}\n";
export const SIMULATOR_ABI = [{"inputs":[{"internalType":"address","name":"pair","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"address","name":"weth","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"bool","name":"quote0","type":"bool"}],"name":"buy","outputs":[{"internalType":"uint256","name":"expected","type":"uint256"},{"internalType":"uint256","name":"received","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"pair","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"address","name":"weth","type":"address"},{"internalType":"address","name":"factory","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"run","outputs":[{"components":[{"internalType":"uint256","name":"stage","type":"uint256"},{"internalType":"uint256","name":"quoteIn","type":"uint256"},{"internalType":"uint256","name":"buyExpected","type":"uint256"},{"internalType":"uint256","name":"buyReceived","type":"uint256"},{"internalType":"uint256","name":"sellTransferred","type":"uint256"},{"internalType":"uint256","name":"sellExpected","type":"uint256"},{"internalType":"uint256","name":"quoteReceived","type":"uint256"},{"internalType":"bytes","name":"revertData","type":"bytes"}],"internalType":"struct RoundTripProbe.Result","name":"r","type":"tuple"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"pair","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"address","name":"weth","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"bool","name":"quote0","type":"bool"}],"name":"sell","outputs":[{"internalType":"uint256","name":"transferred","type":"uint256"},{"internalType":"uint256","name":"expected","type":"uint256"},{"internalType":"uint256","name":"received","type":"uint256"}],"stateMutability":"nonpayable","type":"function"}];
export const SIMULATOR_RUNTIME = "0x6080604052600436101561001257600080fd5b60003560e01c806317f2d9b2146100475780638d7deeae146100425763c8a95e041461003d57600080fd5b610441565b610354565b3461025b576100553661030e565b6100649492939430331461072c565b604051630240bc6b60e21b81526001600160a01b0384169290606081600481875afa90811561023b576100c2916000916000916102b3575b506001600160701b038091866000146102ac57835b87156102a557505b169116836111a6565b956100ce8715156107f7565b6040516370a0823160e01b81523060048201526001600160a01b03919091169590946020866024818a5afa95861561023b57600096610284575b506001600160a01b03821691823b1561025b5760008493600460405180978193630d0e30db60e41b83525af193841561023b5761014a9461026f575b50611210565b8015610268576000905b156102605784905b823b1561025b5760405163022c0d9f60e01b815260048101919091526024810191909152306044820152608060648201526000608482018190529091829060a490829084905af1801561023b57610240575b506040516370a0823160e01b815230600482015291602090839060249082905afa801561023b576101e79260009161020c575b5061085e565b906101f3821515610870565b60408051918252602082019290925290819081015b0390f35b61022e915060203d602011610234575b610226818361077a565b81019061082e565b846101e1565b503d61021c565b6107eb565b8061024f60006102559361077a565b8061083d565b836101ae565b600080fd5b60009061015c565b8490610154565b8061024f600061027e9361077a565b89610144565b61029e91965060203d60201161023457610226818361077a565b9488610108565b90506100b9565b80936100b1565b6001600160701b0392508291506102e19060603d6060116102ec575b6102d9818361077a565b8101906107b5565b50929092915061009c565b503d6102cf565b6001600160a01b0381160361025b57565b8015150361025b57565b60a090600319011261025b57600435610326816102f3565b90602435610333816102f3565b90604435610340816102f3565b906064359060843561035181610304565b90565b3461025b5760a036600319011261025b576103a2600435610374816102f3565b602435610380816102f3565b60443561038c816102f3565b60643591610399836102f3565b60843593610ab4565b60e0604051916020835280516020840152602081015160408401526040810151606084015260608101516080840152608081015160a084015260a081015160c084015260c081015182840152015161010080830152818151918261012083015260005b838110610428575050816000610140809484010152601f80199101168101030190f35b6020828201810151610140878401015285935001610405565b3461025b5761044f3661030e565b919361045c30331461072c565b604051630240bc6b60e21b8152936001600160a01b0382169290606086600481875afa91821561023b57600096600093610704575b506040516370a0823160e01b81526001600160a01b0385811660048301529094908316602086602481845afa92831561023b5761050c966000946106dc575b506104df908360209596611210565b6040516370a0823160e01b81526001600160a01b0390921660048301529094859190829081906024820190565b03915afa801561023b576105356001600160701b0392839261055a9660009161066a575061085e565b966105418815156110f5565b86156106d557835b87156106ce57505b169116856111a6565b93610566851515611131565b6040516370a0823160e01b8152306004820152926001600160a01b03919091169190602084602481865afa93841561023b576000946106ad575b5080156106a55785905b1561069e576000905b823b1561025b5760405163022c0d9f60e01b815260048101919091526024810191909152306044820152608060648201526000608482018190529091829060a490829084905af1801561023b57610689575b506040516370a0823160e01b815230600482015290602090829060249082905afa91821561023b57610208926106429260009161066a575061085e565b61064d811515611169565b604051938493846040919493926060820195825260208201520152565b610683915060203d60201161023457610226818361077a565b386101e1565b8061024f60006106989361077a565b38610605565b85906105b3565b6000906105aa565b6106c791945060203d60201161023457610226818361077a565b92386105a0565b9050610551565b8093610549565b6020945090836106fb6104df93873d891161023457610226818361077a565b955050906104d0565b90925061072191965060603d6060116102ec576102d9818361077a565b509590959138610491565b1561073357565b60405162461bcd60e51b815260206004820152600960248201526853454c465f4f4e4c5960b81b6044820152606490fd5b634e487b7160e01b600052604160045260246000fd5b90601f8019910116810190811067ffffffffffffffff82111761079c57604052565b610764565b51906001600160701b038216820361025b57565b9081606091031261025b576107c9816107a1565b9160406107d8602084016107a1565b92015163ffffffff8116810361025b5790565b6040513d6000823e3d90fd5b156107fe57565b60405162461bcd60e51b8152602060048201526008602482015267445553545f42555960c01b6044820152606490fd5b9081602091031261025b575190565b600091031261025b57565b634e487b7160e01b600052601160045260246000fd5b9190820391821161086b57565b610848565b1561087757565b60405162461bcd60e51b815260206004820152600d60248201526c1393d7d0955657d3d555141555609a1b6044820152606490fd5b60405190610100820182811067ffffffffffffffff82111761079c57604052606060e08360008152600060208201526000604082015260008382015260006080820152600060a0820152600060c08201520152565b1561090857565b60405162461bcd60e51b815260206004820152600b60248201526a50524f42455f46554e445360a81b6044820152606490fd5b9081602091031261025b5751610351816102f3565b1561095757565b60405162461bcd60e51b815260206004820152600d60248201526c504f4f4c5f4944454e5449545960981b6044820152606490fd5b1561099357565b60405162461bcd60e51b815260206004820152600d60248201526c08c8286a89ea4b2be929c888ab609b1b6044820152606490fd5b156109cf57565b60405162461bcd60e51b815260206004820152600c60248201526b4e4f5f4c495155494449545960a01b6044820152606490fd5b15610a0a57565b60405162461bcd60e51b8152602060048201526011602482015270554e53594e4345445f42414c414e43455360781b6044820152606490fd5b919082604091031261025b576020825192015190565b3d15610a94573d9067ffffffffffffffff821161079c5760405191610a88601f8201601f19166020018461077a565b82523d6000602084013e565b606090565b9081606091031261025b578051916040602083015192015190565b909192949394610ac26108ac565b95801515806110eb575b610ad590610901565b604051630dfe168160e01b8152916001600160a01b0384169190602084600481865afa93841561023b576000946110ca575b5060405163c45a015560e01b81526001600160a01b0388811695168514949091602083600481885afa92831561023b576000936110a9575b506001600160a01b039081169216821480610f8a575b610b5f9150610950565b60405163e6a4390560e01b81526001600160a01b0387811660048301528816602482015290602090829060449082905afa90811561023b57610bb5918491600091610f6b575b506001600160a01b03161461098c565b604051630240bc6b60e21b815291606083600481845afa92831561023b57600090600094610f41575b506001600160701b03169283151580610f2f575b610bfb906109c8565b604051630dfe168160e01b815293602085600481865afa94851561023b57600095610f0e575b506040516370a0823160e01b81526001600160a01b038881166004830152909560209187916024918391165afa801561023b578695600091610eef575b50149182610e0b575b505091604091610c79610cc794610a03565b60208a018190528251630bf96cd960e11b81526001600160a01b03808816600483015280891660248301528916604482015260648101919091529015156084820152918290819060a4820190565b03816000305af19081600091600093610dd8575b50610d035750505050505090610cfb610cf2610a59565b600183526112eb565b60e082015290565b6040888101919091526060808901839052905163322a578160e21b81526001600160a01b0394851660048201529484166024860152949092166044840152606483019190915215156084820152908160a4816000305af190600082600092600094610da1575b50610d8c57505050610d85610d7c610a59565b600284526112eb565b60e0830152565b608085015260a084015260c083015260038252565b91509250610dc7915060603d606011610dd1575b610dbf818361077a565b810190610a99565b9190919238610d69565b503d610db5565b909250610dfd915060403d604011610e04575b610df5818361077a565b810190610a43565b9138610cdb565b503d610deb565b6004945060209192506040519485809263d21220a760e01b82525afa92831561023b57600093610ebe575b506040516370a0823160e01b81526001600160a01b038681166004830152909360209185916024918391165afa91821561023b57610c796040938693610cc796600092610e94575b506001600160701b031614929450819350610c67565b6001600160701b03919250610eb79060203d60201161023457610226818361077a565b9190610e7e565b610ee191935060203d602011610ee8575b610ed9818361077a565b81019061093b565b9138610e36565b503d610ecf565b610f08915060203d60201161023457610226818361077a565b38610c5e565b610f2891955060203d602011610ee857610ed9818361077a565b9338610c21565b506001600160701b0381161515610bf2565b6001600160701b039450610f64915060603d6060116102ec576102d9818361077a565b5093610bde565b610f84915060203d602011610ee857610ed9818361077a565b38610ba5565b508415610fed575060405163d21220a760e01b8152602081600481875afa801561023b57610b5f91600091610fce575b506001600160a01b03888116911614610b55565b610fe7915060203d602011610ee857610ed9818361077a565b38610fba565b604051630dfe168160e01b8152602081600481885afa90811561023b5760009161108a575b506001600160a01b0388811691161480611031575b610b5f9150610b55565b5060405163d21220a760e01b815290602082600481885afa801561023b57610b5f9260009161106b575b506001600160a01b031614611027565b611084915060203d602011610ee857610ed9818361077a565b3861105b565b6110a3915060203d602011610ee857610ed9818361077a565b38611012565b6110c391935060203d602011610ee857610ed9818361077a565b9138610b3f565b6110e491945060203d602011610ee857610ed9818361077a565b9238610b07565b5047811115610acc565b156110fc57565b60405162461bcd60e51b815260206004820152600d60248201526c1393d7d4d1531317d253941555609a1b6044820152606490fd5b1561113857565b60405162461bcd60e51b8152602060048201526009602482015268111554d517d4d1531360ba1b6044820152606490fd5b1561117057565b60405162461bcd60e51b815260206004820152600e60248201526d1393d7d4d1531317d3d55514155560921b6044820152606490fd5b9190916103e58102908082046103e5148115171561086b57826103e591020291818304148115171561086b576103e88302928084046103e8149015171561086b57820180921161086b5781156111fa570490565b634e487b7160e01b600052601260045260246000fd5b6000929183809360405190602082019363a9059cbb60e01b855260018060a01b0316602483015260448201526044815261124b60648261077a565b51925af1611257610a59565b8161129c575b501561126557565b60405162461bcd60e51b815260206004820152600f60248201526e1514905394d1915497d19052531151608a1b6044820152606490fd5b8091505180159182156112b2575b50503861125d565b60208214925090826112c8575b505038806112aa565b819250906020918101031261025b57602001516112e481610304565b38806112bf565b6101008151116112f85790565b61010081529056fea164736f6c634300081e000a";
export const SIMULATOR_COMPILER = 'solc-0.8.30+commit.73712a01;viaIR;optimizer200;evm-paris;metadata-none';
const FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const WETH = QUOTE_ASSETS.WETH;
const MAX_AMOUNT = 10n ** 18n;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const unknowns = ['Uma execução num endereço e bloco não prova ausência universal de honeypot.',
  'A chamada usa um contrato efémero; regras diferentes para EOAs, tx.origin e outros endereços continuam por comprovar.',
  'Quantidade fixa em WETH; não comprova executabilidade de uma ordem de 100 USD.',
  'Alterações futuras de taxas, permissões, liquidez e restrições continuam possíveis.'];
const reasons = {
  UNSUPPORTED_POOL_TYPE: 'A simulação de ida e volta está implementada apenas para pools v2.',
  POOL_IDENTITY_NOT_VERIFIED: 'A identidade da pool e a factory oficial precisam de confirmação antes da simulação.',
  INVALID_SIMULATION_INPUT: 'Os dados da pool ou do bloco não permitem uma simulação válida.',
  SIMULATION_HEAD_NOT_FRESH: 'O bloco não tem atualidade suficiente para simular a negociação.',
  UNSUPPORTED_QUOTE: 'A simulação está implementada para pools v2 com WETH; esta moeda de cotação ainda não é suportada.',
  INVALID_PROBE_AMOUNT: 'O montante de teste em WETH é inválido ou excede o limite.',
  INVALID_PROBE_ADDRESS: 'Os endereços temporários não são válidos para uma simulação isolada.',
  SIMULATION_RPC_BUDGET_DEFERRED: 'A simulação foi adiada para preservar o orçamento RPC gratuito.',
  PROBE_ADDRESS_NOT_EMPTY: 'Não foi possível confirmar endereços vazios para instalar o código temporário.',
  SIMULATION_BLOCK_UNCONFIRMED: 'O cabeçalho do bloco não corresponde à observação que seria simulada.',
  SIMULATION_RPC_REVERTED_OR_UNSUPPORTED: 'O RPC recusou a chamada ou a execução inicial reverteu; não existe prova de compra e venda.',
  INVALID_SIMULATION_RESULT: 'A resposta não contém um resultado válido da simulação.',
  INCONSISTENT_SIMULATION_OUTPUTS: 'Os saldos e as etapas devolvidos pela simulação são inconsistentes.',
  SIMULATION_UNAVAILABLE: 'A leitura RPC da simulação não ficou disponível nesta tentativa.',
};
function address() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return '0x' + [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
function revertReason(data) {
  try {
    const error = decodeErrorResult({ abi: [], data });
    return String(error.args?.[0] ?? error.errorName).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  } catch { return null; }
}
const fractionPct = (expected, received) => expected > 0n && received <= expected
  ? Number(((expected - received) * 100000000n + expected - 1n) / expected) / 1000000 : null;

/** Two read-only HTTP batches at most. Only eth_call transient state overrides.
 * A successful result is a narrow observation, never token/trade approval.
 */
export async function simulateTrade(rpc, pool, head, {
  identityVerified = false, probeAmountWei = 10n ** 15n, maxRequests = 30,
  probeAddress = address(), callerAddress = address(), now = Date.now,
} = {}) {
  const assessment = { status: 'unavailable', attempted: false, executionVerified: false,
    method: 'eth_call/stateOverrides', chainId: NETWORK.chainId, blockNumber: head?.number,
    blockHash: head?.hash, quoteAsset: 'WETH', notionalUsd: null, amountUsdVerified: false,
    scope: 'one-address-one-block-fixed-WETH-roundtrip', swapFeeBps: 30, gasLimit: 5000000,
    buySucceeded: null, sellSucceeded: null, approvesTrade: false, unknowns: [...unknowns], gaps: [...unknowns],
    checkedAt: null, canonicalConfirmedBeforeExecution: false, checks: [], risks: [] };
  const evidence = { readOnly: true, statePersistence: 'none', compiler: SIMULATOR_COMPILER,
    runtimeCodeHash: keccak256(SIMULATOR_RUNTIME), probeAddress, callerAddress };
  const result = () => ({ assessment, snapshot: {}, evidence });
  const unavailable = code => {
    assessment.status = 'unavailable'; assessment.reason = code; assessment.executionVerified = false;
    assessment.buySucceeded = null; assessment.sellSucceeded = null;
    assessment.gaps.unshift(reasons[code] ?? 'A simulação não produziu uma prova suficiente nesta leitura.');
    return result();
  };
  if (!pool || pool.type !== 'v2') return unavailable('UNSUPPORTED_POOL_TYPE');
  if (identityVerified !== true || lower(pool.factory) !== FACTORY) return unavailable('POOL_IDENTITY_NOT_VERIFIED');
  if (!isEvmAddress(pool.address) || !isEvmAddress(pool.token0) || !isEvmAddress(pool.token1)
    || !integer(head?.number) || !integer(head?.timestamp) || !hash(head?.hash)) return unavailable('INVALID_SIMULATION_INPUT');
  const clock = now();
  if (!Number.isFinite(clock) || head.timestamp * 1000 > clock + 30000 || clock - head.timestamp * 1000 > 60000)
    return unavailable('SIMULATION_HEAD_NOT_FRESH');
  const quote0 = lower(pool.token0) === WETH; const quote1 = lower(pool.token1) === WETH;
  if (quote0 === quote1) return unavailable('UNSUPPORTED_QUOTE');
  if (typeof probeAmountWei !== 'bigint' || probeAmountWei <= 0n || probeAmountWei > MAX_AMOUNT)
    return unavailable('INVALID_PROBE_AMOUNT');
  if (!isEvmAddress(probeAddress) || !isEvmAddress(callerAddress) || lower(probeAddress) === lower(callerAddress)
    || [pool.address, pool.token0, pool.token1, FACTORY].some(item => [lower(probeAddress), lower(callerAddress)].includes(lower(item))))
    return unavailable('INVALID_PROBE_ADDRESS');
  if (!integer(maxRequests) || maxRequests > 30 || (rpc.requests ?? 0) + 2 > maxRequests)
    return unavailable('SIMULATION_RPC_BUDGET_DEFERRED');
  const token = lower(quote0 ? pool.token1 : pool.token0);
  assessment.requestedQuoteWei = probeAmountWei.toString();
  evidence.token = token; evidence.pool = lower(pool.address); evidence.factory = FACTORY;
  evidence.blockNumber = head.number; evidence.blockHash = head.hash;
  try {
    const codes = await rpc.batch([['eth_getCode', [probeAddress, hex(head.number)]], ['eth_getCode', [callerAddress, hex(head.number)]],
      ['eth_getBlockByNumber', [hex(head.number), false]]]);
    if (!Array.isArray(codes) || codes.length !== 3 || codes.slice(0, 2).some(item => item?.error !== undefined || item?.value !== '0x'))
      return unavailable('PROBE_ADDRESS_NOT_EMPTY');
    const canonical = codes[2]?.value;
    if (!canonical || quantity(canonical.number) !== head.number || lower(canonical.hash) !== lower(head.hash)
      || quantity(canonical.timestamp) !== head.timestamp) return unavailable('SIMULATION_BLOCK_UNCONFIRMED');
    assessment.canonicalConfirmedBeforeExecution = true;
    const data = encodeFunctionData({ abi: SIMULATOR_ABI, functionName: 'run',
      args: [pool.address, token, WETH, FACTORY, probeAmountWei] });
    assessment.attempted = true;
    const [response] = await rpc.batch([['eth_call', [{ from: callerAddress, to: probeAddress,
      data, gas: '0x4c4b40', gasPrice: '0x0' }, hex(head.number), {
      [probeAddress]: { code: SIMULATOR_RUNTIME, balance: hex(probeAmountWei) },
      [callerAddress]: { balance: '0xde0b6b3a7640000' },
    }]]]);
    if (response?.error !== undefined) {
      evidence.rpcErrorCode = response.error; return unavailable('SIMULATION_RPC_REVERTED_OR_UNSUPPORTED');
    }
    if (typeof response?.value !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(response.value)
      || response.value.length > 4096) return unavailable('INVALID_SIMULATION_RESULT');
    const decoded = decodeFunctionResult({ abi: SIMULATOR_ABI, functionName: 'run', data: response.value });
    evidence.resultHash = keccak256(response.value); evidence.resultHex = response.value;
    if (![1n, 2n, 3n].includes(decoded.stage) || decoded.quoteIn !== probeAmountWei) return unavailable('INVALID_SIMULATION_RESULT');
    // Failed external buy/sell calls roll back their outputs. Contradictory
    // tuples cannot serve as transaction evidence, even if the ABI decodes.
    const buyAbsent = decoded.buyExpected === 0n && decoded.buyReceived === 0n;
    const sellAbsent = decoded.sellTransferred === 0n && decoded.sellExpected === 0n && decoded.quoteReceived === 0n;
    if ((decoded.stage === 1n && (!buyAbsent || !sellAbsent))
      || (decoded.stage !== 1n && (decoded.buyExpected === 0n || decoded.buyReceived === 0n))
      || (decoded.stage === 2n && !sellAbsent)
      || (decoded.stage === 3n && (decoded.sellTransferred === 0n || decoded.sellExpected === 0n
        || decoded.quoteReceived !== decoded.sellExpected || decoded.revertData !== '0x')))
      return unavailable('INCONSISTENT_SIMULATION_OUTPUTS');
    assessment.executionVerified = true;
    assessment.checkedAt = new Date(clock).toISOString();
    assessment.stage = decoded.stage === 1n ? 'buy' : decoded.stage === 2n ? 'sell' : 'complete';
    assessment.buySucceeded = decoded.stage !== 1n; assessment.sellSucceeded = decoded.stage === 3n;
    assessment.buy = { quoteInRaw: decoded.quoteIn.toString(), expectedTokenOutRaw: decoded.stage === 1n ? null : decoded.buyExpected.toString(),
      receivedTokenRaw: decoded.stage === 1n ? null : decoded.buyReceived.toString(),
      observedTransferTaxPct: decoded.stage === 1n ? null : fractionPct(decoded.buyExpected, decoded.buyReceived) };
    assessment.sell = { tokenInRaw: decoded.stage === 1n ? null : decoded.buyReceived.toString(),
      receivedByPairRaw: decoded.stage === 3n ? decoded.sellTransferred.toString() : null,
      expectedQuoteOutRaw: decoded.stage === 3n ? decoded.sellExpected.toString() : null,
      receivedQuoteRaw: decoded.stage === 3n ? decoded.quoteReceived.toString() : null,
      observedTransferTaxPct: decoded.stage === 3n ? fractionPct(decoded.buyReceived, decoded.sellTransferred) : null };
    if (decoded.stage === 3n) {
      assessment.status = 'passed'; assessment.reason = 'OBSERVED_ROUNDTRIP_SUCCEEDED';
      assessment.roundtripLossPct = fractionPct(decoded.quoteIn, decoded.quoteReceived);
    } else {
      assessment.status = 'failed'; assessment.reason = 'OBSERVED_BUY_OR_SELL_REVERTED';
      assessment.revertData = decoded.revertData; assessment.revertReason = revertReason(decoded.revertData);
      if (['DUST_BUY', 'DUST_SELL'].includes(assessment.revertReason)) {
        assessment.status = 'unavailable'; assessment.reason = 'PROBE_AMOUNT_DUST';
        assessment.gaps.unshift('O montante de teste gera uma saída demasiado pequena; isso não prova um honeypot.');
      } else {
        assessment.risks.push({ code: 'OBSERVED_TRADE_FAILURE',
          reason: `A ${assessment.stage === 'buy' ? 'compra' : 'venda'} reverteu na execução de teste deste endereço e bloco${assessment.revertReason ? ` (${assessment.revertReason})` : ''}.` });
      }
    }
    const security = {};
    assessment.checks.push({ metric: 'simulation.observedBuySucceeded', value: assessment.buySucceeded, passed: assessment.buySucceeded },
      { metric: 'simulation.observedSellSucceeded', value: assessment.sellSucceeded, passed: assessment.sellSucceeded });
    if (assessment.buy.observedTransferTaxPct > 0) {
      security.buyTaxPct = assessment.buy.observedTransferTaxPct;
      assessment.risks.push({ code: 'OBSERVED_BUY_TRANSFER_FEE', reason: `A compra de teste recebeu menos tokens que a saída da pool: taxa observada de ${security.buyTaxPct}%.` });
    }
    if (assessment.sell.observedTransferTaxPct > 0) {
      security.sellTaxPct = assessment.sell.observedTransferTaxPct;
      assessment.risks.push({ code: 'OBSERVED_SELL_TRANSFER_FEE', reason: `A transferência de venda de teste entregou menos tokens à pool: taxa observada de ${security.sellTaxPct}%.` });
    }
    return { assessment, snapshot: Object.keys(security).length ? { security } : {}, evidence };
  } catch {
    return unavailable('SIMULATION_UNAVAILABLE');
  }
}
