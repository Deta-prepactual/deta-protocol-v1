/*

    Copyright 2018 deta Trading Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

*/

pragma solidity 0.4.24;
pragma experimental "v0.5.0";


/**
 * @title DepositCollateralDelegator
 * @author deta
 *
 * Interface that smart contracts must implement in order to let other addresses deposit heldTokens
 * into a position owned by the smart contract.
 *
 * NOTE: Any contract implementing this interface should also use OnlyMargin to control access
 *       to these functions
 */
interface DepositCollateralDelegator {

    // ============ Public Interface functions ============

    /**
     * Function a contract must implement in order to let other addresses call depositCollateral().
     *
     * @param  depositor   Address of the caller of the depositCollateral() function
     * @param  positionId  Unique ID of the position
     * @param  amount      Requested deposit amount
     * @return             This address to accept, a different address to ask that contract
     */
    function depositCollateralOnBehalfOf(
        address depositor,
        bytes32 positionId,
        uint256 amount
    )
        external
        /* onlyMargin */
        returns (address);
}
