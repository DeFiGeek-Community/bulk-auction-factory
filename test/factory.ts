import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { backToInitMode, goToEmbededMode, hardcodeFactoryAddress, isEmbeddedMode } from "../src/deployUtil";
import { getTokenAbiArgs, getSaleAbiArgs, sendEther, timeTravel } from "./scenarioHelper";

describe("BulkSaleDapp", function () {
    const saleTemplateName = ethers.utils.formatBytes32String("SaleTemplateV1"); // 0x53616c6554656d706c6174655631000000000000000000000000000000000000
    const tokenTemplateName = ethers.utils.formatBytes32String("token"); // 0x746f6b656e000000000000000000000000000000000000000000000000000000
    const initialSupply = ethers.utils.parseEther("1000");

    const DAY = 24 * 60 * 60;

    async function deployFactoryFixture() {
        const [owner, addr1, addr2] = await ethers.getSigners();
    
        const Factory = await ethers.getContractFactory("FactoryV1");
        const factory = await Factory.deploy();
        await factory.deployed();

        return { factory, owner, addr1, addr2 };
    }

    async function deployFactoryAndTemplateFixture() {
        const {factory, owner, addr1, addr2 } = await loadFixture(deployFactoryFixture);
    
        const Sale = await ethers.getContractFactory("SaleTemplateV1");
        const sale = await Sale.deploy();
        await sale.deployed();
    
        await factory.addTemplate(saleTemplateName, sale.address);

        return { factory, sale, owner, addr1, addr2 };
    }

    async function deployTokenFixture() {
        const Token = await ethers.getContractFactory("SampleToken");
        const token = await Token.deploy(initialSupply);
        await token.deployed();
    
        return { token };
      }

    async function deploySaleTemplate(factory: any, tokenAddr: string, ownerAddr: string, allocatedAmount: any, startingAt: number, eventDuration: number, minRaisedAmount: any) {
        const tx = await factory.deploySaleClone(saleTemplateName, tokenAddr, ownerAddr, allocatedAmount, startingAt, eventDuration, minRaisedAmount);
        const receipt = await tx.wait()
        const event = receipt.events.find((event: any) => event.event === 'Deployed');
        const [, templateAddr] = event.args;
        const Sale = await ethers.getContractFactory("SaleTemplateV1");
        return await Sale.attach(templateAddr);
    }

    before(async function() {
        if( !isEmbeddedMode('localhost') ) {
            const { factory } = await loadFixture(deployFactoryFixture);
            hardcodeFactoryAddress("SaleTemplateV1", factory.address);
            this.skip();
        }
    })

    after(async function() {
        if( !isEmbeddedMode('localhost') ) {
            goToEmbededMode('localhost');
        } else {
            backToInitMode('localhost');
        }
    })

    describe("Deploy Factory", function () {
        it("ファクトリーを立ち上げる_success", async function () {
            const { factory, owner } = await loadFixture(deployFactoryFixture);
            const factoryOwner: string = await factory.owner();
            await expect(factoryOwner).to.equal(owner.address);
        });

        it("セールテンプレートをデプロイする_success", async function () {
            const { sale } = await loadFixture(deployFactoryAndTemplateFixture);
            await expect(sale.address).to.be.a.properAddress;
        });

        it("セールテンプレートを追加する_success", async function () {
            const { factory, sale } = await loadFixture(deployFactoryAndTemplateFixture);
            const templateName = await factory.templates(saleTemplateName);
            await expect(templateName).to.equal(sale.address);
        });

        // オーナー以外からの追加
        it("セールテンプレートを追加する_fail", async function () {
            const { factory, sale, addr1 } = await loadFixture(deployFactoryAndTemplateFixture);
            const saleTemplateName2 = ethers.utils.hexZeroPad(
                ethers.utils.hexlify(ethers.utils.toUtf8Bytes("sale2")),
                32
            );
            await expect(factory.connect(addr1).addTemplate(saleTemplateName2, sale.address)).to.be.reverted;
        });

        // 同一名のテンプレート追加
        it("セールテンプレートを追加する_fail", async function () {
            const { factory, sale } = await loadFixture(deployFactoryAndTemplateFixture);
            await expect(factory.addTemplate(saleTemplateName, sale.address)).to.be.revertedWith("This template name is already taken.");
        });

        // デプロイ済みかつ追加済みSaleTemplateV1のFactoryV1からの正常な削除
        it("セールテンプレートを削除する_success", async function () {
            const { factory, sale } = await loadFixture(deployFactoryAndTemplateFixture);
            await expect(await factory.templates(saleTemplateName)).to.equal(sale.address);
            await factory.removeTemplate(saleTemplateName);
            await expect(await factory.templates(saleTemplateName)).to.equal(ethers.constants.AddressZero);
        });

        // 未追加のSaleTemplateV1のFactoryV1からの削除とその他テンプレート情報への影響
        it("セールテンプレートを削除する_success", async function () {
            const { factory, sale } = await loadFixture(deployFactoryAndTemplateFixture);
            await expect(await factory.templates(saleTemplateName)).to.equal(sale.address);
            const templateName = ethers.utils.hexZeroPad(
                ethers.utils.hexlify(ethers.utils.toUtf8Bytes("not_registered")),
                32
            );
            await factory.removeTemplate(templateName);
            await expect(await factory.templates(saleTemplateName)).to.equal(sale.address);
        });

        // オーナー以外からの削除
        it("セールテンプレートを削除する_fail", async function () {
            const { factory, addr1 } = await loadFixture(deployFactoryAndTemplateFixture);
            await expect(factory.connect(addr1).removeTemplate(saleTemplateName)).to.be.reverted;
        });
    });

    describe("Deploy Clone", function () {
        it("sale", async function () {
            const {factory, owner} = await loadFixture(deployFactoryAndTemplateFixture);
            const Token = await ethers.getContractFactory("SampleToken");
            const token = await Token.deploy(initialSupply);
            await token.deployed();

            const allocatedAmount = ethers.utils.parseEther("1")
            await token.approve(factory.address, allocatedAmount);
            const now = await time.latest();

            await expect(factory.deploySaleClone(saleTemplateName, token.address, owner.address, allocatedAmount, now + DAY, DAY, ethers.utils.parseEther("0.1"))).to.not.be.reverted;
        });

        it("reverts with allocatedAmount which exceeds the limit", async function () {
            const {factory, owner} = await loadFixture(deployFactoryAndTemplateFixture);
            const Token = await ethers.getContractFactory("SampleToken");
            const initialSupply = ethers.BigNumber.from(10).pow(50).add(1);
            const token = await Token.deploy(initialSupply);
            await token.deployed();

            const allocatedAmount = initialSupply
            await token.approve(factory.address, allocatedAmount);
            const now = await time.latest();

            await expect(factory.deploySaleClone(saleTemplateName, token.address, owner.address, allocatedAmount, now + DAY, DAY, ethers.utils.parseEther("0.1"))).to.be.reverted;
        });

        it("does not revert with allocatedAmount which is below the limit", async function () {
            const {factory, owner} = await loadFixture(deployFactoryAndTemplateFixture);
            const Token = await ethers.getContractFactory("SampleToken");
            const initialSupply = ethers.BigNumber.from(10).pow(50);
            const token = await Token.deploy(initialSupply);
            await token.deployed();

            const allocatedAmount = initialSupply
            await token.approve(factory.address, allocatedAmount);
            const now = await time.latest();

            await expect(factory.deploySaleClone(saleTemplateName, token.address, owner.address, allocatedAmount, now + DAY, DAY, ethers.utils.parseEther("0.1"))).to.not.be.reverted;
        });

        it("reverts with minRaisedAmount which exceeds the limit", async function () {
            const {factory, owner} = await loadFixture(deployFactoryAndTemplateFixture);
            const Token = await ethers.getContractFactory("SampleToken");
            const initialSupply = ethers.utils.parseEther("100");
            const minRaisedAmount = ethers.BigNumber.from(10).pow(27).add(1);
            const token = await Token.deploy(initialSupply);
            await token.deployed();

            const allocatedAmount = initialSupply
            await token.approve(factory.address, allocatedAmount);
            const now = await time.latest();

            await expect(factory.deploySaleClone(saleTemplateName, token.address, owner.address, allocatedAmount, now + DAY, DAY, minRaisedAmount)).to.be.reverted;
        });

        it("does not revert with minRaisedAmount which is below the limit", async function () {
            const {factory, owner} = await loadFixture(deployFactoryAndTemplateFixture);
            const Token = await ethers.getContractFactory("SampleToken");
            const initialSupply = ethers.utils.parseEther("100");
            const minRaisedAmount = ethers.BigNumber.from(10).pow(27);
            const token = await Token.deploy(initialSupply);
            await token.deployed();

            const allocatedAmount = initialSupply
            await token.approve(factory.address, allocatedAmount);
            const now = await time.latest();

            await expect(factory.deploySaleClone(saleTemplateName, token.address, owner.address, allocatedAmount, now + DAY, DAY, minRaisedAmount)).to.not.be.reverted;
        });
    });

    describe("Template", function() {
        describe("Receive", function() {
            it("reverts with 'The offering has not started yet'", async function () {
                const {factory, owner} = await loadFixture(deployFactoryAndTemplateFixture);
                const {token} = await loadFixture(deployTokenFixture);

                const allocatedAmount = ethers.utils.parseEther("1")
                await token.approve(factory.address, allocatedAmount);
                const now = await time.latest();

                const sale = await deploySaleTemplate(factory, token.address, owner.address, allocatedAmount, now + DAY, DAY, ethers.utils.parseEther("0.1"));

                await expect(sendEther(sale.address, "1", owner)).to.be.revertedWith('The offering has not started yet')
            })

            it("receives ether", async function () {
                const {factory, owner} = await loadFixture(deployFactoryAndTemplateFixture);
                const {token} = await loadFixture(deployTokenFixture);

                const allocatedAmount = ethers.utils.parseEther("1")
                await token.approve(factory.address, allocatedAmount);
                const now = await time.latest();

                const sale = await deploySaleTemplate(factory, token.address, owner.address, allocatedAmount, now + DAY, DAY, ethers.utils.parseEther("0.1"));
                await timeTravel(DAY);
                await sendEther(sale.address, "1", owner)
                const balance = await ethers.provider.getBalance(sale.address);
                const raised = await sale.raised(owner.address);
    
                await expect(balance.toString()).to.eq(ethers.utils.parseEther("1"))
                await expect(raised.toString()).to.eq(ethers.utils.parseEther("1"))
            })
        });

        describe("Claim", function() {
            it("sends token to the claimer when allocatedAmount < totalRaised", async function () {
                const {factory, owner, addr1, addr2} = await loadFixture(deployFactoryAndTemplateFixture);
                const {token} = await loadFixture(deployTokenFixture);

                const allocatedAmount = ethers.utils.parseEther("0.9")
                await token.approve(factory.address, allocatedAmount);
                const now = await time.latest();

                const sale = await deploySaleTemplate(factory, token.address, owner.address, allocatedAmount, now + DAY, DAY, ethers.utils.parseEther("0.1"));

                await timeTravel(DAY);
                await sendEther(sale.address, "1", addr1)
                await sendEther(sale.address, "1", addr2)
                await timeTravel(DAY);
                await sale.claim(addr1.address, addr1.address);
                await sale.claim(addr2.address, addr2.address);
                const user1TokenBalance = await token.balanceOf(addr1.address)
                const user2TokenBalance = await token.balanceOf(addr2.address)
                const contractTokenBalance = await token.balanceOf(sale.address)
    
                await expect(user1TokenBalance.toString()).to.eq(ethers.utils.parseEther("0.45"))
                await expect(user2TokenBalance.toString()).to.eq(ethers.utils.parseEther("0.45"))
                await expect(contractTokenBalance.toString()).to.eq("0")
            });
    
            it("sends tokens to the claimer when allocatedAmount > totalRaised", async function () {
                const {factory, owner, addr1, addr2} = await loadFixture(deployFactoryAndTemplateFixture);
                const {token} = await loadFixture(deployTokenFixture);

                const allocatedAmount = ethers.utils.parseEther("1.9");
                await token.approve(factory.address, allocatedAmount);
                const now = await time.latest();

                const sale = await deploySaleTemplate(factory, token.address, owner.address, allocatedAmount, now + DAY, DAY, ethers.utils.parseEther("0.1"));

                await timeTravel(DAY);
                await sendEther(sale.address, "0.5", addr1)
                await sendEther(sale.address, "0.5", addr2)
                await timeTravel(DAY);
                await sale.claim(addr1.address, addr1.address);
                await sale.claim(addr2.address, addr2.address);
                const user1TokenBalance = await token.balanceOf(addr1.address)
                const user2TokenBalance = await token.balanceOf(addr2.address)
                const contractTokenBalance = await token.balanceOf(sale.address)
    
                await expect(user1TokenBalance.toString()).to.eq(ethers.utils.parseEther("0.95"))
                await expect(user2TokenBalance.toString()).to.eq(ethers.utils.parseEther("0.95"))
                await expect(contractTokenBalance.toString()).to.eq("0")
            });
        });
    });
});